import { describe, expect, it } from 'vitest';
import { presentRelation, relationSummary } from './relationPresentation';
import type { KnowledgeRelation } from './model';

const relation = (overrides: Partial<KnowledgeRelation> = {}): KnowledgeRelation => ({
  id: 'r1', source: 'a', target: 'b', type: 'references', label: '', ...overrides,
});

describe('presentRelation', () => {
  it('uses a readable fallback label and states an outgoing direction', () => {
    expect(presentRelation(relation(), 'a')).toEqual({ direction: 'outgoing', label: '참조함', directionText: '이 자료에서 연결' });
  });
  it('states an incoming direction for directed relations', () => {
    expect(presentRelation(relation({ type: 'based_on', label: '승인 근거' }), 'b')).toEqual({ direction: 'incoming', label: '승인 근거', directionText: '이 자료로 연결' });
  });
  it.each(['related', 'uses_with'] as const)('keeps %s symmetric from either endpoint', (type) => {
    expect(presentRelation(relation({ type }), 'a').direction).toBe('symmetric');
    expect(presentRelation(relation({ type }), 'b').direction).toBe('symmetric');
  });
});

describe('relationSummary', () => {
  it('counts materials separately from multiple relation edges', () => {
    const relations = [relation(), relation({ id: 'r2', type: 'explains' }), relation({ id: 'r3', target: 'c', type: 'related' })];
    expect(relationSummary(relations, 'a')).toEqual({ neighborCount: 2, edgeCount: 3 });
  });
});
