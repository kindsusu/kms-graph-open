import { describe, expect, it } from 'vitest';
import { searchScores } from './search';
import type { KnowledgeItem, KnowledgeRelation } from './model';
const item = (id: string, title: string, extra: Partial<KnowledgeItem> = {}): KnowledgeItem => ({ id, title, kind: 'document', subtype: '', description: '', owner: '', department: '', domain: '', tags: [], ...extra });
describe('deterministic search', () => {
  it('matches every token across fields and prefers title over body', () => {
    const scores = searchScores([item('a', '운영 가이드', { department: '재무' }), item('b', '문서', { body: '운영 가이드 재무' }), item('c', '운영')], [], '운영 재무');
    expect([...scores.keys()]).toEqual(['a', 'b']); expect(scores.get('a')).toBeGreaterThan(scores.get('b')!);
  });
  it('includes relations and shared project names, normalizes case and spacing', () => {
    const relations: KnowledgeRelation[] = [{ id: 'r', source: 'a', target: 'b', type: 'references', label: '품질 검토' }];
    expect(searchScores([item('a', 'Guide'), item('b', 'Other')], relations, ' GUIDE  품질 ' ).has('a')).toBe(true);
    expect(searchScores([item('a', 'Guide')], [], '공용', new Map([['a', ['공용 프로젝트']]])).has('a')).toBe(true);
  });
  it('retains input order for empty queries', () => { expect([...searchScores([item('b', 'B'), item('a', 'A')], [], '').keys()]).toEqual(['b', 'a']); });
});
