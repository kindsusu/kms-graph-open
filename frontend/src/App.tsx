import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import GraphCanvas from './graph/GraphCanvas';
import { isSafeExternalUrl, loadPayload } from './data';
import { searchScores } from './search';
import { itemSharedGroups, matchesSharedScope } from './sharedOrganization';
import { visibleNeighborhood } from './graph/graphMath';
import { graphVisibilitySummary, limitGraphIds } from './graph/visibility';
import { writeSelectionHistory } from './navigation';
import { presentRelation, relationSummary } from './relationPresentation';
import type { GraphStats, ItemKind, KnowledgeItem, KnowledgePayload, KnowledgeRelation, RelationType } from './model';
import OrganizationPanel, { FolderProjectList, type OrganizationActions, type Scope as OrganizationScope } from './organization/OrganizationPanel';
import { emptyOrganization, libraryStorageKey, loadOrganization, parseOrganization, persistOrganization, reduceOrganization, serializeOrganization, type OrganizationAction, type OrganizationState } from './organization/store';

type View = 'graph' | 'list';
type Theme = 'light' | 'dark';
type Sort = 'manual' | 'name' | 'updated' | 'connections';
const PAGE_SIZE = 24;
const RELATION_LABELS: Record<RelationType, string> = { references: '참조', based_on: '근거', explains: '설명', uses_with: '함께 사용', related: '관련' };
const GRAPH_LIMIT = 300;
const KIND_LABEL: Record<ItemKind, string> = { document: '지식·문서', tool: '업무 도구', ai_asset: 'AI 자산' };
const KIND_SHORT: Record<ItemKind, string> = { document: '문서', tool: '도구', ai_asset: 'AI' };

function Icon({ name }: { name: 'library' | 'document' | 'tool' | 'sparkles' | 'graph' | 'search' | 'theme' | 'close' | 'external' }) {
  const paths: Record<typeof name, ReactNode> = {
    library: <><path d="M4 5h16M4 12h16M4 19h16" /></>,
    document: <><path d="M6 3h9l3 3v15H6z" /><path d="M9 10h6M9 14h6M9 18h4" /></>,
    tool: <><path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-3z" /></>,
    sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8zM6 14l.8 2.2L9 17l-2.2.8L6 20l-.8-2.2L3 17l2.2-.8z" /></>,
    graph: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="10" cy="18" r="2" /><path d="m8 7 8 1M7 8l2 8m3-1 5-5" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    theme: <><path d="M20 15.3A8 8 0 1 1 8.7 4 6.5 6.5 0 0 0 20 15.3Z" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v7H4V6h7" /></>,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

class GraphBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('GraphCanvas failed', error, info); }
  render() {
    return this.state.failed ? (
      <div className="state-card"><strong>연결 그래프를 표시할 수 없습니다.</strong><p>목록 보기에서 자료를 계속 탐색할 수 있습니다. 페이지를 새로 고쳐 다시 시도해 주세요.</p></div>
    ) : this.props.children;
  }
}

function useHashSelection(validIds: ReadonlySet<string>) {
  const read = () => {
    const match = location.hash.match(/^#item=(.+)$/);
    if (!match) return null;
    try { const id = decodeURIComponent(match[1]); return validIds.has(id) ? id : null; } catch { return null; }
  };
  const [selectedId, setState] = useState<string | null>(read);
  useEffect(() => {
    const sync = () => setState(read());
    addEventListener('hashchange', sync);
    return () => removeEventListener('hashchange', sync);
  }, [validIds]);
  const select = (id: string | null, replace = false) => {
    if (id === selectedId) return;
    writeSelectionHistory(history, location.pathname, location.search, id, replace);
    setState(id);
  };
  return [selectedId, select] as const;
}

function DetailPanel({ item, relations, byId, payload, onClose, onNavigate }: {
  payload: KnowledgePayload; item: KnowledgeItem; relations: KnowledgeRelation[]; byId: ReadonlyMap<string, KnowledgeItem>;
  onClose: () => void; onNavigate: (id: string) => void;
}) {
  const related = relations.filter((relation) => relation.source === item.id || relation.target === item.id);
  const relationTotals = relationSummary(related, item.id);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, [item.id]);
  return <aside className="detail-panel" aria-labelledby="detail-title">
    <div className="detail-head"><span className={`kind-pill ${item.kind}`}>{KIND_SHORT[item.kind]} · {item.subtype || '미분류'}</span><button ref={closeRef} className="icon-button" onClick={onClose} aria-label="상세 닫기"><Icon name="close" /></button></div>
    <h2 id="detail-title">{item.title}</h2><p className="lede">{item.description || '설명이 등록되지 않았습니다.'}</p>
    <dl className="metadata">
      <div><dt>담당</dt><dd>{item.owner || '미등록'}</dd></div><div><dt>부서</dt><dd>{item.department || '미등록'}</dd></div>
      <div><dt>업무 분야</dt><dd>{item.domain || '미분류'}</dd></div><div><dt>상태</dt><dd>{item.status || '미등록'}</dd></div>
      {item.sourceId && <div><dt>출처 ID</dt><dd>{item.sourceId}</dd></div>}{item.sourceUpdatedAt && <div><dt>원본 수정일</dt><dd>{item.sourceUpdatedAt}</dd></div>}{item.collectedAt && <div><dt>수집일</dt><dd>{item.collectedAt}</dd></div>}<div><dt>URL 확인</dt><dd>{({ ok: '확인됨', unchecked: '미확인', unreachable: '접속 불가', auth_required: '인증 필요' } as const)[item.health ?? 'unchecked']}</dd></div>
      {item.version && <div><dt>버전</dt><dd>{item.version}</dd></div>}{item.updatedAt && <div><dt>업데이트</dt><dd>{item.updatedAt}</dd></div>}
    </dl>
    {isSafeExternalUrl(item.sourceUrl) && <a className="primary-link" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">출처 열기 <Icon name="external" /></a>}
    {(item.folderIds?.length || item.projectIds?.length) ? <section><h3>공용 소속 <span>읽기 전용</span></h3><p className="muted">{itemSharedGroups(item, payload).map((group) => group.title).join(' · ')}</p></section> : null}
    {payload.reviewCandidates?.filter((candidate) => candidate.itemId === item.id).map((candidate) => <section key={candidate.itemId} className="review-notice"><h3>지난 빌드 대비 재검토 후보</h3><p>{candidate.reason}</p><p className="muted">변경된 의존 자료: {candidate.changedSourceIds.map((id) => byId.get(id)?.title ?? '현재 게시 범위에서 제외된 자료').join(' · ') || '게시 제외된 의존 자료'}{candidate.removedSourceCount ? ` · 제외된 원본 ${candidate.removedSourceCount}개` : ''}</p><p className="muted">명시된 참조·근거 관계를 따른 후보입니다. 유효성은 담당자가 확인하며, 다음 동일 빌드에서는 이 안내가 사라집니다.</p></section>)}
    <div className="tags" aria-label="태그">{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
    {item.body && <section><h3>내용</h3><p className="body-copy">{item.body}</p></section>}
    {item.kind === 'ai_asset' && item.subtype === '프롬프트' && item.prompt && <section><h3>프롬프트</h3><pre className="prompt">{item.prompt}</pre></section>}
    {isSafeExternalUrl(item.url) && <a className="primary-link" href={item.url} target="_blank" rel="noopener noreferrer">원본 열기 <Icon name="external" /></a>}
    <section><h3>연결된 자료 <span>{relationTotals.neighborCount}개</span></h3>
      {related.length > 0 && <p className="relation-summary">자료 {relationTotals.neighborCount}개 · 관계 {relationTotals.edgeCount}개</p>}
      {related.length ? <ul className="relations">{related.map((relation) => {
        const outgoing = relation.source === item.id;
        const other = byId.get(outgoing ? relation.target : relation.source);
        const presentation = presentRelation(relation, item.id);
        return other && <li key={relation.id}><button onClick={() => onNavigate(other.id)}><span className={`relation-direction ${presentation.direction}`}>{presentation.directionText} · {presentation.label}</span><strong>{other.title}</strong>{relation.evidence && <span className="relation-evidence">근거: {relation.evidence}</span>}</button>{isSafeExternalUrl(relation.evidenceUrl) && <a href={relation.evidenceUrl} target="_blank" rel="noopener noreferrer">관계 근거 원본</a>}</li>;
      })}</ul> : <p className="muted">표시할 관계가 없습니다.</p>}
    </section>
  </aside>;
}

function Workspace({ payload }: { payload: KnowledgePayload }) {
  const ids = useMemo(() => new Set(payload.items.map((item) => item.id)), [payload.items]);
  const byId = useMemo(() => new Map(payload.items.map((item) => [item.id, item])), [payload.items]);
  const [selectedId, select] = useHashSelection(ids);
  const [view, setView] = useState<View>('list');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ItemKind | 'all'>('all');
  const [domain, setDomain] = useState('all');
  const [sharedScope, setSharedScope] = useState('all');
  const [sort, setSort] = useState<Sort>('name');
  const [relationType, setRelationType] = useState<RelationType | 'all'>('all');
  const [graphLimit, setGraphLimit] = useState(GRAPH_LIMIT);
  const [depth, setDepth] = useState<0 | 1 | 2>(0);
  const [page, setPage] = useState(1);
  const [focusNonce, setFocusNonce] = useState(0);
  const [stats, setStats] = useState<GraphStats>({ visibleNodes: payload.items.length, visibleEdges: payload.relations.length, layoutRunning: true });
  const [theme, setTheme] = useState<Theme>(() => { try { return localStorage.getItem('kms-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } });
  const libraryKey = useMemo(() => libraryStorageKey(payload.isDemo ? 'demo' : 'production'), [payload.isDemo]);
  const [organization, setOrganization] = useState<OrganizationState>(() => emptyOrganization(libraryKey));
  const [organizationScope, setOrganizationScope] = useState<OrganizationScope>(null);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [organizationNotice, setOrganizationNotice] = useState<string | null>(null);
  const [organizationUndo, setOrganizationUndo] = useState<OrganizationState | null>(null);
  const [organizationRaw, setOrganizationRaw] = useState<string | null>(null);
  const [corruptOrganizationRaw, setCorruptOrganizationRaw] = useState<string | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(() => new Set());
  const [pendingImport, setPendingImport] = useState<OrganizationState | null>(null);
  const importCloseRef = useRef<HTMLButtonElement>(null);
  const importReturnRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectionTriggerRef = useRef<HTMLElement | null>(null);
  const domains = useMemo(() => [...new Set(payload.items.map((item) => item.domain))].sort((a, b) => a.localeCompare(b, 'ko')), [payload.items]);
  const relationCount = useMemo(() => {
    const neighbors = new Map(payload.items.map((item) => [item.id, new Set<string>()]));
    payload.relations.forEach((relation) => { neighbors.get(relation.source)?.add(relation.target); neighbors.get(relation.target)?.add(relation.source); });
    return new Map([...neighbors].map(([id, related]) => [id, related.size]));
  }, [payload.items, payload.relations]);

  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('kms-theme', theme); } catch { /* Storage can be disabled by policy. */ } }, [theme]);
  useEffect(() => {
    try { const loaded = loadOrganization(localStorage, libraryKey); setOrganization(loaded.state); setOrganizationRaw(loaded.raw); setCorruptOrganizationRaw(loaded.error ? loaded.raw : null); if (loaded.error) setOrganizationNotice('저장된 내 정리를 열 수 없습니다. 원본 내보내기 또는 검증된 가져오기로 복구하세요.'); }
    catch { setOrganization(emptyOrganization(libraryKey)); setOrganizationRaw(null); setOrganizationNotice('브라우저 저장소를 사용할 수 없습니다.'); }
  }, [libraryKey]);
  useEffect(() => setPage(1), [query, kind, domain, sort, sharedScope]);
  useEffect(() => setSelectedItemIds(new Set()), [query, kind, domain, page, organizationScope, sharedScope]);
  useEffect(() => { if (pendingImport) importCloseRef.current?.focus(); }, [pendingImport]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest('[role="dialog"]')) return;
      if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape' && query) { setQuery(''); searchRef.current?.focus(); }
    };
    addEventListener('keydown', keyboard); return () => removeEventListener('keydown', keyboard);
  }, [query]);

  const scopedItemIds = useMemo(() => organizationScope?.type === 'project' ? new Set(organization.memberships.filter((membership) => membership.projectId === organizationScope.id).map((membership) => membership.itemId)) : null, [organizationScope, organization.memberships]);
  const sharedLabels = useMemo(() => new Map(payload.items.map((item) => [item.id, itemSharedGroups(item, payload).map((group) => group.title)])), [payload]);
  const scores = useMemo(() => searchScores(payload.items, payload.relations, query, sharedLabels), [payload.items, payload.relations, query, sharedLabels]);
  const filtered = useMemo(() => {
    return payload.items.filter((item) => {
      if (scopedItemIds && !scopedItemIds.has(item.id)) return false;
      if (kind !== 'all' && item.kind !== kind) return false;
      if (domain !== 'all' && item.domain !== domain) return false;
      if (!matchesSharedScope(item, payload, sharedScope)) return false;
      return scores.has(item.id);
    }).sort((a, b) => {
      if (query.trim() && scores.get(a.id) !== scores.get(b.id)) return (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
      if (organizationScope?.type === 'project' && sort === 'manual') return (organization.memberships.find((membership) => membership.projectId === organizationScope.id && membership.itemId === a.id)?.order ?? 0) - (organization.memberships.find((membership) => membership.projectId === organizationScope.id && membership.itemId === b.id)?.order ?? 0);
      if (sort === 'connections') return (relationCount.get(b.id) ?? 0) - (relationCount.get(a.id) ?? 0) || a.title.localeCompare(b.title, 'ko');
      if (sort === 'updated') return (b.sourceUpdatedAt ?? b.updatedAt ?? '').localeCompare(a.sourceUpdatedAt ?? a.updatedAt ?? '') || a.title.localeCompare(b.title, 'ko');
      return a.title.localeCompare(b.title, 'ko');
    });
  }, [payload.items, query, kind, domain, sort, relationCount, scopedItemIds, organization.memberships, organizationScope, scores, sharedScope, payload]);
  const visibleIds = useMemo(() => new Set(filtered.map((item) => item.id)), [filtered]);
  const graphRelationTypes = useMemo(() => relationType === 'all' ? undefined : new Set([relationType]), [relationType]);
  const graphRelations = useMemo(() => payload.relations.filter((edge) => relationType === 'all' || edge.type === relationType), [payload.relations, relationType]);
  const graphScopeIds = useMemo(() => visibleNeighborhood(payload.items, graphRelations, visibleIds, selectedId, depth), [payload.items, graphRelations, visibleIds, selectedId, depth]);
  const graphVisibleIds = useMemo(() => limitGraphIds(filtered, graphScopeIds, graphLimit, selectedId, graphRelations), [filtered, graphScopeIds, graphLimit, selectedId, graphRelations]);
  const graphVisibility = useMemo(() => graphVisibilitySummary(graphRelations, graphScopeIds, graphVisibleIds, selectedId), [graphRelations, graphScopeIds, graphVisibleIds, selectedId]);
  const selectedTypeHiddenCount = useMemo(() => selectedId && relationType !== 'all' ? payload.relations.filter((edge) => edge.type !== relationType && (edge.source === selectedId || edge.target === selectedId)).length : 0, [payload.relations, relationType, selectedId]);
  const graphScopeRelationCount = graphVisibility.scopeEdges;
  useEffect(() => setGraphLimit(GRAPH_LIMIT), [query, kind, domain, depth, relationType, organizationScope, sharedScope]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { if (selectedId && !visibleIds.has(selectedId)) { select(null, true); setDepth(0); } }, [selectedId, visibleIds]);
  const chooseKind = (next: ItemKind | 'all') => { setSharedScope('all'); setOrganizationScope(null); setSort('name'); setKind(next); setView('list'); };
  const selectFrom = (id: string, trigger?: HTMLElement | null) => { selectionTriggerRef.current = trigger ?? document.activeElement as HTMLElement | null; select(id); };
  const closeDetail = () => { const trigger = selectionTriggerRef.current; select(null); requestAnimationFrame(() => trigger?.isConnected && trigger.focus()); };
  const navigateRelation = (id: string) => { setSharedScope('all'); setQuery(''); setKind('all'); setDomain('all'); setOrganizationScope(null); select(id); };
  const openGraph = () => { setView('graph'); if (selectedId) setDepth(1); };
  const showInGraph = (id: string, trigger?: HTMLElement | null) => { selectionTriggerRef.current = trigger ?? document.activeElement as HTMLElement | null; select(id); setView('graph'); setDepth(1); setFocusNonce((value) => value + 1); };
  const applyOrganization = (action: OrganizationAction | OrganizationAction[]) => {
    try {
      if (corruptOrganizationRaw !== null) throw new Error('손상된 기존 내 정리를 덮어쓸 수 없습니다. 원본을 내보내거나 검증된 파일을 가져오세요.');
      const actions = Array.isArray(action) ? action : [action];
      const next = actions.reduce(reduceOrganization, organization);
      const raw = persistOrganization(localStorage, next, { expectedRaw: organizationRaw });
      setOrganizationRaw(raw);
      setOrganizationUndo(organization); setOrganization(next); setOrganizationNotice('내 정리에 저장했습니다.');
    } catch (error) { setOrganizationNotice(error instanceof Error ? error.message : '내 정리를 저장하지 못했습니다.'); }
  };
  const organizationActions: OrganizationActions = {
    createFolder: (name) => applyOrganization({ type: 'folder/create', id: crypto.randomUUID(), name }), renameFolder: (id, name) => applyOrganization({ type: 'folder/rename', id, name }), deleteFolder: (id) => applyOrganization({ type: 'folder/delete', id }),
    createProject: (name, folderId) => applyOrganization({ type: 'project/create', id: crypto.randomUUID(), name, folderId }), renameProject: (id, name) => applyOrganization({ type: 'project/rename', id, name }), deleteProject: (id) => applyOrganization({ type: 'project/delete', id }),
    moveProject: (id, folderId, beforeId) => applyOrganization({ type: 'project/move', id, folderId, beforeId }), moveFolder: (id, beforeId) => applyOrganization({ type: 'folder/move', id, beforeId }),
    exportJson: () => { const blob = new Blob([corruptOrganizationRaw ?? serializeOrganization(organization)], { type: 'application/json' }); const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = corruptOrganizationRaw ? 'kms-library-organization-recovery.json' : 'kms-library-organization.json'; anchor.click(); URL.revokeObjectURL(anchor.href); },
    importJson: (file) => { if (file.size > 2_000_000) { setOrganizationNotice('가져오기 파일은 2MB 이하여야 합니다.'); return; } importReturnRef.current = document.activeElement as HTMLElement | null; const reader = new FileReader(); reader.onerror = () => setOrganizationNotice('가져오기 파일을 읽지 못했습니다.'); reader.onload = () => { try { setPendingImport(parseOrganization(JSON.parse(String(reader.result)), libraryKey)); } catch (error) { setOrganizationNotice(error instanceof Error ? error.message : '가져오기 파일이 올바르지 않습니다.'); } }; reader.readAsText(file); },
    moveItemToProject: (itemId, projectId) => applyOrganization(organizationScope?.type === 'project' ? { type: 'item/move', fromProjectId: organizationScope.id, toProjectId: projectId, itemId } : { type: 'item/link', projectId, itemId }),
  };
  const organizationCounts = useMemo(() => new Map(organization.projects.map((project) => [project.id, organization.memberships.filter((membership) => membership.projectId === project.id && byId.has(membership.itemId)).length])), [organization, byId]);
  const missingScopedItems = useMemo(() => organizationScope?.type === 'project' ? organization.memberships.filter((membership) => membership.projectId === organizationScope.id && !byId.has(membership.itemId)).length : 0, [organizationScope, organization.memberships, byId]);
  useEffect(() => { if (organizationScope?.type === 'project' && !organization.projects.some((project) => project.id === organizationScope.id)) { setOrganizationScope(null); setPage(1); } if (organizationScope?.type === 'folder' && !organization.folders.some((folder) => folder.id === organizationScope.id)) { setOrganizationScope(null); setPage(1); } }, [organization, organizationScope]);
  const chooseOrganizationScope = (scope: OrganizationScope) => { setSharedScope('all'); setOrganizationScope(scope); setSort(scope?.type === 'project' ? 'manual' : 'name'); setOrganizationOpen(() => typeof matchMedia === 'function' ? !matchMedia('(max-width: 900px)').matches : true); setView('list'); setPage(1); setQuery(''); setKind('all'); setDomain('all'); };
  const changeMembership = (itemId: string, projectId: string) => organizationActions.moveItemToProject?.(itemId, projectId);
  const canManualReorder = organizationScope?.type === 'project' && sort === 'manual' && !query && kind === 'all' && domain === 'all' && sharedScope === 'all';
  const moveWithinProject = (itemId: string, direction: 'start' | 'up' | 'down' | 'end') => {
    if (organizationScope?.type !== 'project' || !canManualReorder) return;
    const index = filtered.findIndex((item) => item.id === itemId);
    const before = direction === 'start' ? filtered[0]?.id : direction === 'up' ? filtered[index - 1]?.id : direction === 'down' ? filtered[index + 2]?.id : undefined;
    if ((direction === 'start' && index === 0) || (direction === 'end' && index === filtered.length - 1) || (direction === 'up' && index <= 0) || (direction === 'down' && (index < 0 || index === filtered.length - 1))) return;
    applyOrganization({ type: 'item/reorder', projectId: organizationScope.id, itemId, beforeItemId: before === itemId ? undefined : before });
  };
  const graphOutsideCount = useMemo(() => organizationScope?.type === 'project' ? payload.relations.filter((relation) => scopedItemIds?.has(relation.source) !== scopedItemIds?.has(relation.target)).length : 0, [organizationScope, payload.relations, scopedItemIds]);
  const scopedRelationCount = useMemo(() => payload.relations.filter((relation) => visibleIds.has(relation.source) && visibleIds.has(relation.target)).length, [payload.relations, visibleIds]);

  return <div className={`app-shell ${selected ? 'has-detail' : ''}`}>
    <header className="topbar"><button className="brand" onClick={() => chooseKind('all')}><span className="brand-mark">K</span><span>{payload.title}</span></button>
      {payload.isDemo && <span className="demo-badge">개발 샘플 · {payload.items.length}개</span>}
      <button className="theme-button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`${theme === 'light' ? '어두운' : '밝은'} 테마로 전환`} aria-pressed={theme === 'dark'}><Icon name="theme" /></button>
    </header>
    <nav className="sidebar" aria-label="자료 유형">
      <p className="nav-label">라이브러리</p>
      <button className={organizationScope === null && kind === 'all' && view === 'list' ? 'active' : ''} onClick={() => chooseKind('all')} aria-current={organizationScope === null && kind === 'all' && view === 'list' ? 'page' : undefined}><span><Icon name="library" /></span>모든 자료<small>{payload.items.length}</small></button>
      {(Object.keys(KIND_LABEL) as ItemKind[]).map((value) => <button key={value} className={kind === value ? 'active' : ''} onClick={() => chooseKind(value)} aria-current={kind === value ? 'page' : undefined}><span><Icon name={value === 'document' ? 'document' : value === 'tool' ? 'tool' : 'sparkles'} /></span>{KIND_LABEL[value]}<small>{payload.items.filter((item) => item.kind === value).length}</small></button>)}
      <div className="nav-separator" /><p className="nav-label">탐색</p>
      <button className={view === 'graph' ? 'active' : ''} onClick={openGraph} aria-current={view === 'graph' ? 'page' : undefined}><span><Icon name="graph" /></span>연결 그래프</button>
      <OrganizationPanel folders={organization.folders} projects={organization.projects} counts={organizationCounts} scope={organizationScope} onScope={chooseOrganizationScope} actions={organizationActions} open={organizationOpen} onOpen={() => setOrganizationOpen(true)} onClose={() => setOrganizationOpen(false)} />
    </nav>
    <main className="workspace">
      <div className="workspace-head"><div><p className="eyebrow">KNOWLEDGE LIBRARY</p><h1>{view === 'graph' ? '연결 그래프' : organizationScope?.type === 'project' ? organization.projects.find((project) => project.id === organizationScope.id)?.name ?? '프로젝트' : organizationScope?.type === 'folder' ? organization.folders.find((folder) => folder.id === organizationScope.id)?.name ?? '폴더' : kind === 'all' ? '모든 자료' : KIND_LABEL[kind]}</h1><p className="workspace-summary">{filtered.length.toLocaleString()}개 자료 · {scopedRelationCount.toLocaleString()}개 연결</p></div>
        <div className="view-toggle" aria-label="보기 방식"><button className={view === 'graph' ? 'active' : ''} onClick={openGraph}>그래프</button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>목록</button></div>
      </div>
      {organizationScope?.type === 'folder' ? <FolderProjectList folder={organization.folders.find((folder) => folder.id === organizationScope.id)!} projects={organization.projects} counts={organizationCounts} onScope={chooseOrganizationScope} /> : <><div className="org-project-breadcrumb">{organizationScope?.type === 'project' && <>내 정리 <span>›</span> {organization.projects.find((project) => project.id === organizationScope.id)?.folderId ? organization.folders.find((folder) => folder.id === organization.projects.find((project) => project.id === organizationScope.id)?.folderId)?.name : '미분류 프로젝트'} <span>›</span> {organization.projects.find((project) => project.id === organizationScope.id)?.name}</>}</div><div className="filterbar"><label className="search"><span><Icon name="search" /></span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목, 부서, 분야, 관계 검색" aria-label="자료 검색" />{query && <button onClick={() => setQuery('')} aria-label="검색어 지우기"><Icon name="close" /></button>}<kbd>/</kbd></label>
        <select value={kind} onChange={(event) => setKind(event.target.value as ItemKind | 'all')} aria-label="자료 유형"><option value="all">모든 유형</option>{(Object.keys(KIND_LABEL) as ItemKind[]).map((value) => <option key={value} value={value}>{KIND_LABEL[value]}</option>)}</select>
        <select value={domain} onChange={(event) => setDomain(event.target.value)} aria-label="업무 분야"><option value="all">모든 업무 분야</option>{domains.map((value) => <option key={value} value={value}>{value || '미분류'}</option>)}</select>
        {(payload.sharedFolders?.length || payload.sharedProjects?.length) ? <select value={sharedScope} onChange={(event) => setSharedScope(event.target.value)} aria-label="공용 소속 읽기 전용"><option value="all">모든 공용 소속</option>{payload.sharedFolders?.map((group) => <option key={`folder:${group.id}`} value={`folder:${group.id}`}>공용 폴더 · {group.title}</option>)}{payload.sharedProjects?.map((group) => <option key={`project:${group.id}`} value={`project:${group.id}`}>공용 프로젝트 · {group.folderId ? `${payload.sharedFolders?.find((folder) => folder.id === group.folderId)?.title} / ` : ''}{group.title}</option>)}</select> : null}
        <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="정렬">{organizationScope?.type === 'project' && <option value="manual">수동 순서</option>}<option value="name">이름순</option><option value="updated">최신순</option><option value="connections">연결 많은 순</option></select>
      </div>
      <div className="content-stack"><section className={`graph-pane ${view !== 'graph' ? 'view-hidden' : ''}`} aria-label="연결 그래프">
        <div className="graph-toolbar"><span><strong>{stats.visibleNodes.toLocaleString()}</strong> / {graphScopeIds.size.toLocaleString()}개 자료 · <strong>{stats.visibleEdges.toLocaleString()}</strong> / {graphScopeRelationCount.toLocaleString()}개 연결 {stats.layoutRunning && <i>배치 중</i>}</span>
          <div className="depth-control" aria-label="연결 범위"><button className={depth === 0 ? 'active' : ''} onClick={() => setDepth(0)}>전체 범위</button><button disabled={!selected} className={depth === 1 ? 'active' : ''} onClick={() => setDepth(1)}>선택 주변 1단계</button><button disabled={!selected} className={depth === 2 ? 'active' : ''} onClick={() => setDepth(2)}>2단계</button>{selected && <button onClick={() => setFocusNonce((value) => value + 1)}>선택으로 이동</button>}</div>
        </div>
        <div className="graph-scope-controls"><label>관계 <select value={relationType} onChange={(event) => setRelationType(event.target.value as RelationType | 'all')}><option value="all">모든 관계</option>{(Object.keys(RELATION_LABELS) as RelationType[]).map((type) => <option key={type} value={type}>{RELATION_LABELS[type]}</option>)}</select></label><span role="status">{graphVisibleIds.size < graphScopeIds.size ? `표시량 제한 · 자료 ${graphScopeIds.size - graphVisibleIds.size}개 · 연결 ${graphVisibility.hiddenEdges}개 생략` : '현재 범위 모두 표시'} · 연결 주변 우선 · 라벨은 확대 시 더 표시{selectedId && <> · 선택 연결 {graphVisibility.selectedShownEdges}/{graphVisibility.selectedScopeEdges}개{graphVisibility.selectedOutsideScopeEdges > 0 && <> · 범위 밖 {graphVisibility.selectedOutsideScopeEdges}개</>}{selectedTypeHiddenCount > 0 && <> · 관계 필터 제외 {selectedTypeHiddenCount}개</>}</>}</span>{graphVisibleIds.size < graphScopeIds.size && <button onClick={() => setGraphLimit((value) => value + GRAPH_LIMIT)}>연결 주변 300개 더 보기</button>}<button onClick={() => setView('list')}>목록으로 탐색</button></div>
        {graphScopeIds.size > 0 && graphScopeRelationCount === 0 && <p className="graph-no-relations" role="status">현재 범위에 해당 관계가 없습니다. 자료는 계속 표시되며, 관계 필터를 넓혀 연결을 확인할 수 있습니다.</p>}
        <GraphBoundary><GraphCanvas items={payload.items} relations={payload.relations} selectedId={selectedId} onSelect={(id) => id ? selectFrom(id) : closeDetail()} visibleIds={graphVisibleIds} localDepth={0} relationTypes={graphRelationTypes} focusRequest={selectedId ? { id: selectedId, nonce: focusNonce } : null} onStats={setStats} /></GraphBoundary>
        {!filtered.length && <div className="empty empty-overlay"><strong>조건에 맞는 자료가 없습니다.</strong><p>검색어를 지우거나 필터 범위를 넓혀 보세요.</p><button onClick={() => { setQuery(''); setKind('all'); setDomain('all'); setSharedScope('all'); }}>필터 초기화</button></div>}
        {graphOutsideCount > 0 && <button className="org-graph-outside" onClick={() => { setOrganizationScope(null); setSharedScope('all'); setView('graph'); }}>범위 밖 연결 {graphOutsideCount}개 · 전체 그래프</button>}<div className="graph-legend" aria-label="자료 유형 범례"><span><i className="kind-dot document" />문서</span><span><i className="kind-dot tool" />도구</span><span><i className="kind-dot ai_asset" />AI 자산</span><span>→ 방향 관계 · — 상호 관계</span><span>크기: 전체 고유 연결 자료 수</span></div>
      </section><section className={`list-pane ${view !== 'list' ? 'view-hidden' : ''}`} aria-label="자료 목록">
        <div className="list-summary"><span><strong>{filtered.length.toLocaleString()}</strong>개 자료</span><span>{page} / {pages} 페이지</span></div>
        {missingScopedItems > 0 && <p className="org-missing-notice">원본에서 사라진 자료 소속 {missingScopedItems}개는 보존되어 있으며, ID가 돌아오면 다시 표시됩니다.</p>}
        {shown.length ? <div className="item-table" role="table" aria-label="자료 목록"><div className="table-header" role="row"><span role="columnheader">자료명</span><span role="columnheader">유형</span><span role="columnheader">업무 분야</span><span role="columnheader">담당</span><span role="columnheader">연결 자료</span><span role="columnheader">업데이트</span><span role="columnheader"><span className="sr-only">그래프 작업</span></span></div>{shown.map((item) => <div role="row" key={item.id} onDragOver={(event) => { if (canManualReorder) event.preventDefault(); }} onDrop={(event) => { const source = event.dataTransfer.getData('text/kms-item-id'); if (canManualReorder && source && source !== item.id) applyOrganization({ type: 'item/reorder', projectId: organizationScope!.id, itemId: source, beforeItemId: item.id }); }} className={`table-row ${item.id === selectedId ? 'selected' : ''}`}>
          <span role="cell"><div className="org-item-controls"><button draggable className="item-drag-handle" onDragStart={(event) => event.dataTransfer.setData('text/kms-item-id', item.id)} aria-label={`${item.title} 프로젝트로 ${organizationScope?.type === 'project' ? '이동' : '연결'}`}>⠿</button><input type="checkbox" aria-label={`${item.title} 선택`} checked={selectedItemIds.has(item.id)} onChange={(event) => setSelectedItemIds((previous) => { const next = new Set(previous); event.target.checked ? next.add(item.id) : next.delete(item.id); return next; })} /><button className="row-title" onClick={(event) => selectFrom(item.id, event.currentTarget)}><span className={`kind-dot ${item.kind}`} /><span><strong>{item.title}</strong><small>{item.description || '설명 미등록'}</small></span></button>{organizationScope?.type === 'project' && <select disabled={!canManualReorder} className="item-project-menu" aria-label={`${item.title} 순서 변경`} value="" onChange={(event) => { const direction = event.target.value as 'start' | 'up' | 'down' | 'end'; if (direction) moveWithinProject(item.id, direction); }}><option value="">순서</option><option value="start">맨 위</option><option value="up">위로</option><option value="down">아래로</option><option value="end">맨 아래</option></select>}{organization.projects.length > 0 && <select className="item-project-menu" aria-label={`${item.title} 프로젝트 메뉴`} value="" onChange={(event) => { const divider = event.target.value.indexOf(':'); const mode = event.target.value.slice(0, divider); const projectId = event.target.value.slice(divider + 1); if (projectId) mode === 'link' ? applyOrganization({ type: 'item/link', projectId, itemId: item.id }) : changeMembership(item.id, projectId); }}><option value="">···</option>{organization.projects.filter((project) => project.id !== organizationScope?.id).flatMap((project) => [<option key={`move-${project.id}`} value={`move:${project.id}`}>{project.name}{organizationScope?.type === 'project' ? '로 이동' : '에 연결'}</option>, ...(organizationScope?.type === 'project' ? [<option key={`link-${project.id}`} value={`link:${project.id}`}>{project.name}에도 연결</option>] : [])])}</select>}</div></span>
          <span className={`kind-text ${item.kind}`} role="cell">{KIND_SHORT[item.kind]}</span><span role="cell" className="cell-secondary">{item.domain || '미분류'}</span><span role="cell" className="cell-secondary">{item.owner || '미등록'}</span><span role="cell" className="connection-count">{relationCount.get(item.id) ?? 0}</span><span role="cell" className="cell-secondary">{item.sourceUpdatedAt || item.updatedAt || '—'}</span>
          <span role="cell"><button className="graph-jump" onClick={(event) => showInGraph(item.id, event.currentTarget)} aria-label={`${item.title}을 그래프에서 보기`} title="그래프에서 보기"><Icon name="graph" /></button></span>
        </div>)}</div> : <div className="empty"><strong>조건에 맞는 자료가 없습니다.</strong><button onClick={() => { setQuery(''); setKind('all'); setDomain('all'); setSharedScope('all'); }}>필터 초기화</button></div>}
        <div className="org-membership-tools"><span>{selectedItemIds.size}개 선택</span>{organizationScope?.type === 'project' ? <><select aria-label="선택한 자료를 프로젝트로 이동" defaultValue="" onChange={(event) => { const destination = event.target.value; if (!destination) return; applyOrganization([...selectedItemIds].map((itemId) => ({ type: 'item/move' as const, fromProjectId: organizationScope.id, toProjectId: destination, itemId }))); setSelectedItemIds(new Set()); event.currentTarget.value = ''; }}><option value="">선택한 자료 이동…</option>{organization.projects.filter((project) => project.id !== organizationScope.id).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button disabled={!selectedItemIds.size} onClick={() => { applyOrganization([...selectedItemIds].map((itemId) => ({ type: 'item/unlink' as const, projectId: organizationScope.id, itemId }))); setSelectedItemIds(new Set()); }}>프로젝트에서 빼기</button></> : <select aria-label="선택한 자료를 프로젝트에 연결" defaultValue="" onChange={(event) => { const projectId = event.target.value; if (!projectId) return; applyOrganization([...selectedItemIds].map((itemId) => ({ type: 'item/link' as const, projectId, itemId }))); setSelectedItemIds(new Set()); event.currentTarget.value = ''; }}><option value="">선택한 자료 연결…</option>{organization.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}</div>
        {pages > 1 && <div className="pagination"><button disabled={page === 1} onClick={() => setPage((value) => value - 1)}>이전</button><span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)}</span><button disabled={page === pages} onClick={() => setPage((value) => value + 1)}>다음</button></div>}
      </section></div></>}
    </main>
    {pendingImport && <div className="org-dialog-backdrop"><div className="org-dialog" role="dialog" aria-modal="true" aria-label="내 정리 가져오기" onKeyDown={(event) => { if (event.key === 'Escape') { setPendingImport(null); requestAnimationFrame(() => importReturnRef.current?.focus()); } if (event.key === 'Tab') { const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')]; const first = focusable[0]; const last = focusable[focusable.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }}}><h2>내 정리 교체</h2><p>현재 이 브라우저의 폴더, 프로젝트, 자료 소속을 가져온 파일로 교체합니다.</p><div><button ref={importCloseRef} onClick={() => { setPendingImport(null); requestAnimationFrame(() => importReturnRef.current?.focus()); }}>취소</button><button onClick={() => { try { const raw = persistOrganization(localStorage, pendingImport, { expectedRaw: organizationRaw }); setOrganizationUndo(organization); setOrganization(pendingImport); setOrganizationRaw(raw); setCorruptOrganizationRaw(null); setOrganizationScope(null); setPage(1); setPendingImport(null); setOrganizationNotice('내 정리를 가져왔습니다.'); requestAnimationFrame(() => importReturnRef.current?.focus()); } catch (error) { setPendingImport(null); setOrganizationNotice(error instanceof Error ? error.message : '가져오기를 저장하지 못했습니다.'); } }}>교체하기</button></div></div></div>}
    {organizationNotice && <div className="org-toast" role="status">{organizationNotice}{organizationUndo && <button onClick={() => { try { const raw = persistOrganization(localStorage, organizationUndo, { expectedRaw: organizationRaw }); setOrganization(organizationUndo); setOrganizationRaw(raw); setOrganizationUndo(null); setOrganizationNotice('변경을 되돌렸습니다.'); } catch { setOrganizationNotice('되돌리기를 저장하지 못했습니다.'); } }}>실행 취소</button>}<button onClick={() => setOrganizationNotice(null)} aria-label="알림 닫기">×</button></div>}
    {selected && <DetailPanel item={selected} payload={payload} relations={payload.relations} byId={byId} onClose={closeDetail} onNavigate={navigateRelation} />}
  </div>;
}

export default function App() {
  const [state, setState] = useState<{ payload?: KnowledgePayload; error?: string }>({});
  useEffect(() => { let active = true; loadPayload().then((payload) => active && setState({ payload })).catch((error) => active && setState({ error: error instanceof Error ? error.message : '알 수 없는 오류' })); return () => { active = false; }; }, []);
  if (state.error) return <main className="fatal"><span className="brand-mark">K</span><p className="eyebrow">DATA ERROR</p><h1>지식 데이터를 열 수 없습니다.</h1><p>{state.error}</p><p className="muted">게시 담당자에게 빌드 결과와 데이터 형식을 확인해 달라고 요청하세요.</p></main>;
  if (!state.payload) return <main className="loading"><span className="spinner" /><span>지식 지도를 준비하는 중…</span></main>;
  if (!state.payload.items.length) return <main className="fatal"><span className="brand-mark">K</span><h1>아직 등록된 자료가 없습니다.</h1><p>수집 원본을 확인한 뒤 사이트를 다시 빌드해 주세요.</p></main>;
  return <Workspace payload={state.payload} />;
}
