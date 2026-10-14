import type { KnowledgeItem, KnowledgeRelation } from '../model';
/** Traverse only real, in-scope connections. A larger budget extends the same prefix. */
export function limitGraphIds(items: readonly KnowledgeItem[], scope: ReadonlySet<string>, limit: number, selectedId: string | null, relations: readonly KnowledgeRelation[] = []): Set<string> {
  const ids = items.filter((item) => scope.has(item.id)).map((item) => item.id);
  const adjacency = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const edge of relations) {
    if (edge.source === edge.target || !adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  const rank = new Map(ids.map((id, index) => [id, index]));
  const compare = (a: string, b: string) => adjacency.get(b)!.size - adjacency.get(a)!.size || rank.get(a)! - rank.get(b)!;
  const roots = [...ids].sort(compare);
  if (selectedId && adjacency.has(selectedId)) roots.unshift(selectedId);
  const shown = new Set<string>();
  const queued = new Set<string>();
  const budget = Math.max(1, Math.floor(limit));
  for (const root of roots) {
    if (queued.has(root)) continue;
    const queue = [root]; queued.add(root);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor]; shown.add(id);
      if (shown.size >= budget) return shown;
      for (const neighbor of [...adjacency.get(id)!].sort(compare)) {
        if (queued.has(neighbor)) continue;
        queued.add(neighbor); queue.push(neighbor);
      }
    }
  }
  return shown;
}

/** Counts actual edges, including different relations between the same pair. */
export function graphVisibilitySummary(relations: readonly KnowledgeRelation[], scope: ReadonlySet<string>, shown: ReadonlySet<string>, selectedId: string | null) {
  let scopeEdges = 0; let shownEdges = 0; let selectedScopeEdges = 0; let selectedShownEdges = 0; let selectedOutsideScopeEdges = 0;
  for (const edge of relations) {
    const inScope = scope.has(edge.source) && scope.has(edge.target);
    const isShown = shown.has(edge.source) && shown.has(edge.target);
    const selected = selectedId !== null && (edge.source === selectedId || edge.target === selectedId);
    if (inScope) scopeEdges += 1;
    if (isShown) shownEdges += 1;
    if (selected && inScope) selectedScopeEdges += 1;
    if (selected && isShown) selectedShownEdges += 1;
    if (selected && !inScope) selectedOutsideScopeEdges += 1;
  }
  return { scopeEdges, shownEdges, hiddenEdges: scopeEdges - shownEdges, selectedScopeEdges, selectedShownEdges, selectedOutsideScopeEdges };
}
