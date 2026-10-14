import { expect, it } from 'vitest';
import { graphVisibilitySummary, limitGraphIds } from './visibility';
import { visibleNeighborhood } from './graphMath';
import type { KnowledgeItem, KnowledgeRelation } from '../model';
it('caps a dense scope without dropping selected items or importing filtered items', () => {
  const items = Array.from({ length: 1000 }, (_, n) => ({ id: String(n) } as KnowledgeItem));
  const scope = new Set(items.map((item) => item.id));
  const limited = limitGraphIds(items, scope, 300, '999');
  expect(limited.size).toBe(300); expect(limited.has('999')).toBe(true); expect(limited.has('299')).toBe(false);
  expect(limitGraphIds(items, new Set(['1']), 300, '999')).toEqual(new Set(['1']));
  expect(limitGraphIds(items, scope, 1200, null).size).toBe(1000);
});

const itemsFor = (...ids: string[]) => ids.map((id) => ({ id } as KnowledgeItem));
const edge = (source: string, target: string, type: KnowledgeRelation['type'] = 'related'): KnowledgeRelation => ({ id: `${source}-${target}-${type}`, source, target, type, label: '' });

it('prioritizes connected components over alphabetical isolates and extends the same traversal', () => {
  const items = itemsFor('a-isolate', 'b-isolate', 'c', 'd', 'e', 'f', 'g');
  const relations = [edge('c', 'd'), edge('d', 'e'), edge('f', 'g')];
  const scope = new Set(items.map((item) => item.id));
  const first = limitGraphIds(items, scope, 3, null, relations);
  expect([...first]).toEqual(['d', 'c', 'e']);
  const more = limitGraphIds(items, scope, 5, null, relations);
  expect([...more]).toEqual(['d', 'c', 'e', 'f', 'g']);
  expect([...first].every((id) => more.has(id))).toBe(true);
  expect(limitGraphIds(items, scope, 5, null, [...relations].reverse())).toEqual(more);
});

it('keeps a late selected hub with its neighbors and exposes omitted hub relations', () => {
  const items = Array.from({ length: 1000 }, (_, n) => ({ id: String(n) } as KnowledgeItem));
  const relations = items.slice(0, -1).map((item) => edge('999', item.id));
  const scope = new Set(items.map((item) => item.id));
  const first = limitGraphIds(items, scope, 300, '999', relations);
  expect([...first].slice(0, 3)).toEqual(['999', '0', '1']);
  expect(first.size).toBe(300);
  expect(graphVisibilitySummary(relations, scope, first, '999')).toMatchObject({ shownEdges: 299, hiddenEdges: 700, selectedShownEdges: 299, selectedScopeEdges: 999, selectedOutsideScopeEdges: 0 });
  const more = limitGraphIds(items, scope, 600, '999', relations);
  expect([...more].slice(0, 300)).toEqual([...first]);
  expect(graphVisibilitySummary(relations, scope, more, '999').shownEdges).toBe(599);
});

it('visits direct neighbors before second hops and retains a selected isolate', () => {
  const items = itemsFor('remote', 'first', 'second', 'selected', 'isolate');
  const relations = [edge('selected', 'first'), edge('selected', 'second'), edge('first', 'remote')];
  const scope = new Set(items.map((item) => item.id));
  expect([...limitGraphIds(items, scope, 3, 'selected', relations)]).toEqual(['selected', 'first', 'second']);
  expect([...limitGraphIds(items, scope, 2, 'isolate', relations)]).toEqual(['isolate', 'first']);
});

it('never crosses filtered nodes and distinguishes scope omissions from cap omissions', () => {
  const items = itemsFor('selected', 'allowed', 'outside', 'across');
  const relations = [edge('selected', 'allowed'), edge('selected', 'outside'), edge('outside', 'across'), edge('selected', 'allowed', 'references')];
  const allowed = new Set(['selected', 'allowed', 'across']);
  const scope = visibleNeighborhood(items, relations, allowed, 'selected', 2);
  expect(scope).toEqual(new Set(['selected', 'allowed']));
  const shown = limitGraphIds(items, scope, 1, 'selected', relations);
  expect(shown).toEqual(new Set(['selected']));
  expect(graphVisibilitySummary(relations, scope, shown, 'selected')).toMatchObject({ hiddenEdges: 2, selectedScopeEdges: 2, selectedOutsideScopeEdges: 1 });
  const filteredRelations = relations.filter((relation) => relation.type === 'references');
  const filteredShown = limitGraphIds(items, allowed, 3, 'selected', filteredRelations);
  expect([...filteredShown]).toEqual(['selected', 'allowed', 'across']);
  expect(graphVisibilitySummary(filteredRelations, allowed, filteredShown, 'selected')).toMatchObject({ scopeEdges: 1, hiddenEdges: 0, selectedOutsideScopeEdges: 0 });
});

it('does not invent links for disconnected data or count duplicate neighbors as extra degree', () => {
  const items = itemsFor('a', 'b', 'c', 'd');
  const scope = new Set(items.map((item) => item.id));
  expect([...limitGraphIds(items, scope, 2, null, [])]).toEqual(['a', 'b']);
  const relations = [edge('a', 'b'), edge('a', 'b', 'references'), edge('c', 'd')];
  expect([...limitGraphIds(items, scope, 2, null, relations)]).toEqual(['a', 'b']);
  expect(graphVisibilitySummary([], scope, new Set(['a', 'b']), null).shownEdges).toBe(0);
});
