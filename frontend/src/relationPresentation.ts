import type { KnowledgeRelation, RelationType } from './model';

const FALLBACK_LABEL: Record<RelationType, string> = {
  references: '참조함',
  based_on: '근거로 함',
  explains: '설명함',
  uses_with: '함께 사용',
  related: '관련',
};

const SYMMETRIC_TYPES = new Set<RelationType>(['uses_with', 'related']);

export type RelationDirection = 'outgoing' | 'incoming' | 'symmetric';

export interface RelationPresentation {
  direction: RelationDirection;
  label: string;
  directionText: string;
}

/** Presents the relation from the open material's perspective. */
export function presentRelation(relation: KnowledgeRelation, currentId: string): RelationPresentation {
  const label = relation.label.trim() || FALLBACK_LABEL[relation.type];
  if (SYMMETRIC_TYPES.has(relation.type)) return { direction: 'symmetric', label, directionText: '상호 연결' };
  if (relation.source === currentId) return { direction: 'outgoing', label, directionText: '이 자료에서 연결' };
  return { direction: 'incoming', label, directionText: '이 자료로 연결' };
}

export function relationSummary(relations: KnowledgeRelation[], currentId: string) {
  const neighbors = new Set<string>();
  for (const relation of relations) {
    if (relation.source === currentId) neighbors.add(relation.target);
    else if (relation.target === currentId) neighbors.add(relation.source);
  }
  return { neighborCount: neighbors.size, edgeCount: relations.length };
}
