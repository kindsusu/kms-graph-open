import type { ItemKind, KnowledgeItem, KnowledgePayload, KnowledgeRelation, RelationType } from './model';

const ITEM_KINDS = new Set<ItemKind>(['document', 'tool', 'ai_asset']);
const RELATION_TYPES = new Set<RelationType>(['references', 'based_on', 'explains', 'uses_with', 'related']);
const SYMMETRIC_RELATION_TYPES = new Set<RelationType>(['uses_with', 'related']);
const HEALTH_VALUES = new Set(['ok', 'unchecked', 'unreachable', 'auth_required']);

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PayloadError(`${path}은(는) 객체여야 합니다.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PayloadError(`${path}은(는) 비어 있지 않은 문자열이어야 합니다.`);
  return value.trim();
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new PayloadError(`${path}은(는) 문자열이어야 합니다.`);
  return value.trim();
}

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return text(value, path);
}

function optionalIds(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new PayloadError(`${path}은(는) ID 배열이어야 합니다.`);
  return [...new Set(value.map((id, i) => text(id, `${path}[${i}]`)))];
}
function optionalUrl(value: unknown, path: string): string | undefined {
  const url = optionalText(value, path);
  if (url && !isSafeExternalUrl(url)) throw new PayloadError(`${path} URL이 올바르지 않습니다.`);
  return url;
}

function parseItem(value: unknown, index: number): KnowledgeItem {
  const path = `items[${index}]`;
  const raw = record(value, path);
  const kind = text(raw.kind, `${path}.kind`);
  if (!ITEM_KINDS.has(kind as ItemKind)) throw new PayloadError(`${path}.kind 값이 올바르지 않습니다.`);
  if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
    throw new PayloadError(`${path}.tags은(는) 문자열 배열이어야 합니다.`);
  }
  const itemSubtype = string(raw.subtype, `${path}.subtype`);
  const prompt = optionalText(raw.prompt, `${path}.prompt`);
  if (prompt && (kind !== 'ai_asset' || itemSubtype !== '프롬프트')) {
    throw new PayloadError(`${path}.prompt는 AI 자산의 프롬프트 유형에만 허용됩니다.`);
  }
  const health = optionalText(raw.health, `${path}.health`);
  if (health && !HEALTH_VALUES.has(health)) throw new PayloadError(`${path}.health 값이 올바르지 않습니다.`);
  return {
    id: text(raw.id, `${path}.id`),
    title: text(raw.title, `${path}.title`),
    kind: kind as ItemKind,
    subtype: itemSubtype,
    description: string(raw.description, `${path}.description`),
    owner: string(raw.owner, `${path}.owner`),
    department: string(raw.department, `${path}.department`),
    domain: string(raw.domain, `${path}.domain`),
    tags: raw.tags.map((tag) => (tag as string).trim()),
    url: optionalText(raw.url, `${path}.url`),
    body: optionalText(raw.body, `${path}.body`),
    prompt,
    version: optionalText(raw.version, `${path}.version`),
    updatedAt: optionalText(raw.updatedAt, `${path}.updatedAt`),
    status: optionalText(raw.status, `${path}.status`),
    health: health as KnowledgeItem['health'],
    sourceId: optionalText(raw.sourceId, `${path}.sourceId`),
    sourceUrl: optionalUrl(raw.sourceUrl, `${path}.sourceUrl`),
    sourceUpdatedAt: optionalText(raw.sourceUpdatedAt, `${path}.sourceUpdatedAt`),
    collectedAt: optionalText(raw.collectedAt, `${path}.collectedAt`),
    folderIds: optionalIds(raw.folderIds, `${path}.folderIds`),
    projectIds: optionalIds(raw.projectIds, `${path}.projectIds`),
  };
}

function parseRelation(value: unknown, index: number): KnowledgeRelation {
  const path = `relations[${index}]`;
  const raw = record(value, path);
  const type = text(raw.type, `${path}.type`);
  if (!RELATION_TYPES.has(type as RelationType)) throw new PayloadError(`${path}.type 값이 올바르지 않습니다.`);
  return {
    id: text(raw.id, `${path}.id`),
    source: text(raw.source, `${path}.source`),
    target: text(raw.target, `${path}.target`),
    type: type as RelationType,
    label: string(raw.label, `${path}.label`),
    evidence: optionalText(raw.evidence, `${path}.evidence`),
    evidenceUrl: optionalUrl(raw.evidenceUrl, `${path}.evidenceUrl`),
  };
}

export function parsePayload(value: unknown): KnowledgePayload {
  const raw = record(value, 'payload');
  if (raw.schemaVersion !== 2) throw new PayloadError('지원하지 않는 데이터 버전입니다. schemaVersion 2가 필요합니다.');
  if (!Array.isArray(raw.items) || !Array.isArray(raw.relations)) throw new PayloadError('items와 relations 배열이 필요합니다.');
  const items = raw.items.map(parseItem);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new PayloadError(`중복 항목 ID가 있습니다: ${item.id}`);
    ids.add(item.id);
  }
  const relations = raw.relations.map(parseRelation);
  const relationIds = new Set<string>();
  const relationTuples = new Set<string>();
  for (const relation of relations) {
    if (relationIds.has(relation.id)) throw new PayloadError(`중복 관계 ID가 있습니다: ${relation.id}`);
    relationIds.add(relation.id);
    if (!ids.has(relation.source) || !ids.has(relation.target)) throw new PayloadError(`관계 ${relation.id}이(가) 없는 항목을 참조합니다.`);
    if (relation.source === relation.target) throw new PayloadError(`관계 ${relation.id}은(는) 자기 자신을 연결합니다.`);
    const [first, second] = SYMMETRIC_RELATION_TYPES.has(relation.type)
      ? [relation.source, relation.target].sort()
      : [relation.source, relation.target];
    const tuple = JSON.stringify([first, second, relation.type]);
    if (relationTuples.has(tuple)) throw new PayloadError(`중복 관계가 있습니다: ${relation.id}`);
    relationTuples.add(tuple);
  }
  const parseGroups = (key: 'sharedFolders' | 'sharedProjects') => {
    if (raw[key] === undefined) return undefined;
    if (!Array.isArray(raw[key])) throw new PayloadError(`${key}은(는) 배열이어야 합니다.`);
    const groupIds = new Set<string>();
    return raw[key].map((value, index) => {
      const group = record(value, `${key}[${index}]`); const id = text(group.id, `${key}.id`);
      if (groupIds.has(id)) throw new PayloadError(`중복 공용 ID: ${id}`); groupIds.add(id);
      return { id, title: text(group.title, `${key}.title`), description: group.description === undefined ? '' : string(group.description, `${key}.description`), folderId: key === 'sharedProjects' ? optionalText(group.folderId, `${key}.folderId`) : undefined };
    });
  };
  const sharedFolders = parseGroups('sharedFolders'); const sharedProjects = parseGroups('sharedProjects');
  const folderIds = new Set(sharedFolders?.map((group) => group.id));
  if (sharedProjects?.some((group) => group.folderId && !folderIds.has(group.folderId))) throw new PayloadError('공용 프로젝트가 없는 폴더를 참조합니다.');
  for (const [groups, key] of [[sharedFolders, 'folderIds'], [sharedProjects, 'projectIds']] as const) {
    const groupIds = new Set(groups?.map((group) => group.id));
    for (const item of items) if (item[key]?.some((id) => !groupIds.has(id))) throw new PayloadError(`없는 공용 소속: ${item.id}`);
  }
  let reviewCandidates: KnowledgePayload['reviewCandidates'];
  if (raw.reviewCandidates !== undefined) {
    if (!Array.isArray(raw.reviewCandidates)) throw new PayloadError('reviewCandidates는 배열이어야 합니다.');
    const candidateIds = new Set<string>();
    reviewCandidates = raw.reviewCandidates.map((value) => {
      const candidate = record(value, 'reviewCandidate'); const itemId = text(candidate.itemId, 'reviewCandidate.itemId');
      if (!ids.has(itemId)) throw new PayloadError(`없는 재검토 자료: ${itemId}`);
      if (candidateIds.has(itemId)) throw new PayloadError(`중복 재검토 후보: ${itemId}`);
      candidateIds.add(itemId);
      const changedSourceIds = optionalIds(candidate.changedSourceIds, 'reviewCandidate.changedSourceIds') ?? [];
      if (changedSourceIds.some((id) => !ids.has(id))) throw new PayloadError('재검토 후보가 없는 변경 원본을 참조합니다.');
      const removedSourceCount = candidate.removedSourceCount;
      if (removedSourceCount !== undefined && (typeof removedSourceCount !== 'number' || !Number.isSafeInteger(removedSourceCount) || removedSourceCount < 0)) throw new PayloadError('removedSourceCount는 0 이상의 정수여야 합니다.');
      return { itemId, changedSourceIds, reason: text(candidate.reason, 'reviewCandidate.reason'), removedSourceCount: removedSourceCount as number | undefined };
    });
  }
  return {
    schemaVersion: 2,
    title: text(raw.title, 'title'),
    generatedAt: text(raw.generatedAt, 'generatedAt'),
    items,
    relations,
    isDemo: raw.isDemo === true || undefined,
    sharedFolders, sharedProjects, reviewCandidates,
  };
}

export async function loadPayload(): Promise<KnowledgePayload> {
  const node = document.getElementById('kms-data');
  const source = node?.textContent?.trim() ?? '';
  if (!source || source === '/*__KMS_DATA__*/') {
    if (import.meta.env.DEV) {
      const { createDemoPayload } = await import('./development/demo');
      const count = new URLSearchParams(location.search).get('demo') === '1000' ? 1000 : 150;
      return parsePayload(createDemoPayload(count));
    }
    throw new PayloadError('게시 데이터가 포함되지 않았습니다. Python 빌더로 사이트를 다시 생성해 주세요.');
  }
  try {
    return parsePayload(JSON.parse(source));
  } catch (error) {
    if (error instanceof PayloadError) throw error;
    throw new PayloadError(`게시 데이터를 읽을 수 없습니다: ${error instanceof Error ? error.message : 'JSON 오류'}`);
  }
}

export function isSafeExternalUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password && !/[\u0000-\u0020\u007f]/.test(url);
  } catch {
    return false;
  }
}
