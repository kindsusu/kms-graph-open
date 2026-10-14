import type { ItemKind, KnowledgeItem, KnowledgePayload, KnowledgeRelation } from '../model';

const topics = ['고객 지원', '정보 보안', '신규 입사', '제품 분석', '디자인 시스템', '영업 운영', '데이터 품질', '클라우드 비용', '계약 검토', '서비스 장애'];
const departments = ['제품팀', '플랫폼팀', '고객경험팀', '경영지원팀', '데이터팀'];
const kinds: ItemKind[] = ['document', 'tool', 'ai_asset'];
const subtype: Record<ItemKind, string[]> = {
  document: ['가이드', '정책', '회고', 'FAQ'],
  tool: ['대시보드', '워크플로', '업무 시스템'],
  ai_asset: ['프롬프트', '에이전트', '평가셋'],
};

export function createDemoPayload(count = 150): KnowledgePayload {
const items: KnowledgeItem[] = Array.from({ length: count }, (_, index) => {
  const kind = kinds[index % kinds.length];
  const topic = topics[index % topics.length];
  const itemSubtype = subtype[kind][Math.floor(index / kinds.length) % subtype[kind].length];
  const ordinal = Math.floor(index / topics.length) + 1;
  const base: KnowledgeItem = {
    id: `demo-${index + 1}`,
    title: `${topic} ${itemSubtype} ${ordinal}`,
    kind,
    subtype: itemSubtype,
    description: `${topic} 업무에서 반복해서 참고하는 ${itemSubtype} 샘플입니다. 담당자가 목적과 적용 범위를 확인할 수 있습니다.`,
    owner: `${departments[index % departments.length]} 운영자`,
    department: departments[index % departments.length],
    domain: topic,
    tags: [topic, itemSubtype, index % 2 ? '운영' : '핵심'],
    body: `${topic}의 주요 원칙, 적용 절차, 예외 상황을 정리한 개발용 콘텐츠입니다. 실제 게시 데이터로 빌드하면 이 샘플은 사용되지 않습니다.`,
    version: `v${1 + (index % 3)}.${index % 10}`,
    updatedAt: `2026-08-${String(1 + (index % 28)).padStart(2, '0')}`,
    status: index % 8 === 0 ? '검토 중' : '사용 중',
    health: 'ok',
    sourceId: `demo-source-${index + 1}`,
    sourceUrl: `https://example.com/knowledge/${index + 1}`,
    sourceUpdatedAt: `2026-08-${String(1 + (index % 28)).padStart(2, '0')}`,
    collectedAt: '2026-09-08T12:00:00Z',
    folderIds: index < 20 ? ['shared-operations'] : [],
    projectIds: index < 10 ? ['shared-onboarding'] : [],
  };
  if (kind === 'tool') base.url = `https://example.com/tools/${index + 1}`;
  if (kind === 'ai_asset' && itemSubtype === '프롬프트') base.prompt = `${topic} 상황과 원하는 결과를 입력받아 근거, 판단, 다음 행동 순서로 정리하세요.`;
  return base;
});

const relations: KnowledgeRelation[] = [];
for (let index = 0; index < items.length; index += 1) {
  const targets = [(index + 1) % items.length, (index + 10) % items.length];
  targets.forEach((target, relationIndex) => {
    relations.push({
      id: `demo-r-${index}-${relationIndex}`,
      source: items[index].id,
      target: items[target].id,
      type: relationIndex === 0 ? 'related' : 'references',
      label: relationIndex === 0 ? '함께 참고' : '근거로 사용',
      evidence: relationIndex === 0 ? '업무 담당자가 함께 참고하도록 등록한 관계입니다.' : '본문의 적용 절차가 연결된 자료를 참조합니다.',
      evidenceUrl: `https://example.com/evidence/${index + 1}`,
    });
  });
}

return {
  schemaVersion: 2,
  title: '사내 지식 연결 그래프',
  generatedAt: '2026-09-08T12:00:00Z',
  items,
  relations,
  isDemo: true,
  sharedFolders: [{ id: 'shared-operations', title: '운영 자료', description: '원본에서 관리하는 공용 폴더' }],
  sharedProjects: [{ id: 'shared-onboarding', title: '입사 안내', description: '원본에서 관리하는 공용 프로젝트', folderId: 'shared-operations' }],
  reviewCandidates: count > 11 ? [{ itemId: 'demo-1', changedSourceIds: ['demo-11'], reason: '의존 자료 변경으로 재검토 필요' }] : [],
};
}

export const demoPayload = createDemoPayload();
