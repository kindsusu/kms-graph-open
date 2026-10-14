import type { KnowledgeItem, KnowledgeRelation } from '../model';

export interface Point { x: number; y: number }
export interface ViewTransform { x: number; y: number; k: number }
export interface PositionedNode extends Point { id: string }

export type LabelTier = 'focus' | 'neighbor' | 'other';

export const MIN_ZOOM = 0.18;
export const MAX_ZOOM = 5;

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(k) ? k : 1));
}

export function zoomAt(
  transform: ViewTransform,
  screen: Point,
  nextScale: number,
): ViewTransform {
  const k = clampZoom(nextScale);
  const wx = (screen.x - transform.x) / transform.k;
  const wy = (screen.y - transform.y) / transform.k;
  return { x: screen.x - wx * k, y: screen.y - wy * k, k };
}

export function fitTransform(
  nodes: readonly Point[],
  width: number,
  height: number,
  padding = 44,
): ViewTransform {
  if (!nodes.length || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, k: 1 };
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
  }
  if (!Number.isFinite(minX)) return { x: width / 2, y: height / 2, k: 1 };
  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const k = clampZoom(Math.min(innerW / spanX, innerH / spanY, 1.6));
  return { x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k, k };
}

export function nearestNode(
  nodes: readonly PositionedNode[],
  world: Point,
  scale: number,
  minimumScreenRadius = 10,
): PositionedNode | null {
  const maxWorld = minimumScreenRadius / Math.max(scale, MIN_ZOOM);
  let best: PositionedNode | null = null;
  let bestD2 = maxWorld * maxWorld;
  for (const node of nodes) {
    const dx = node.x - world.x; const dy = node.y - world.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) { bestD2 = d2; best = node; }
  }
  return best;
}

export function buildAdjacency(items: readonly KnowledgeItem[], relations: readonly KnowledgeRelation[]): Map<string, Set<string>> {
  const ids = new Set(items.map((item) => item.id));
  const adjacency = new Map<string, Set<string>>(items.map((item) => [item.id, new Set()]));
  for (const relation of relations) {
    if (!ids.has(relation.source) || !ids.has(relation.target) || relation.source === relation.target) continue;
    adjacency.get(relation.source)!.add(relation.target);
    adjacency.get(relation.target)!.add(relation.source);
  }
  return adjacency;
}

/**
 * A compact visual encoding for connection breadth. `degree` must come from
 * unique neighbours rather than raw edge count so parallel typed relations do
 * not make a node look more important than its actual reach.
 */
export function nodeRadiusForDegree(degree: number): number {
  const safeDegree = Math.max(0, Number.isFinite(degree) ? degree : 0);
  return 3.2 + Math.min(2.3, Math.log2(safeDegree + 1) * .5);
}

export function labelTier(
  id: string,
  selectedId: string | null,
  hoveredId: string | null,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): LabelTier {
  if (id === selectedId || id === hoveredId) return 'focus';
  // Hover is the active inspection target. Keep the selected node's own label
  // visible, but do not mix two separate neighborhoods while inspecting hover.
  const focusId = hoveredId ?? selectedId;
  if (focusId && adjacency.get(focusId)?.has(id)) return 'neighbor';
  return 'other';
}

export function labelRank(
  id: string,
  degree: number,
  selectedId: string | null,
  hoveredId: string | null,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): number {
  const tier = labelTier(id, selectedId, hoveredId, adjacency);
  const tierWeight = tier === 'focus' ? 2_000_000 : tier === 'neighbor' ? 1_000_000 : 0;
  return tierWeight + degree;
}

export function isDirectionalRelation(type: KnowledgeRelation['type']): boolean {
  return type !== 'related' && type !== 'uses_with';
}

export function relationFallbackLabel(type: KnowledgeRelation['type']): string {
  return ({ references: '참조함', based_on: '근거로 함', explains: '설명함', uses_with: '함께 사용', related: '관련됨' } as const)[type];
}

export function relationDisplayLabel(relation: KnowledgeRelation): string {
  return relation.label.trim() || relationFallbackLabel(relation.type);
}

export function visibleNeighborhood(
  items: readonly KnowledgeItem[],
  relations: readonly KnowledgeRelation[],
  visibleIds: ReadonlySet<string> | undefined,
  selectedId: string | null,
  depth: 0 | 1 | 2,
): Set<string> {
  const allowed = new Set(items.filter((item) => !visibleIds || visibleIds.has(item.id)).map((item) => item.id));
  if (depth === 0 || !selectedId || !allowed.has(selectedId)) return allowed;
  const adjacency = buildAdjacency(items, relations);
  const result = new Set<string>([selectedId]);
  let frontier = [selectedId];
  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (allowed.has(neighbor) && !result.has(neighbor)) { result.add(neighbor); next.push(neighbor); }
      }
    }
    frontier = next;
  }
  return result;
}

function hashUnit(value: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

export function seedPositions(
  ids: readonly string[],
  relations: readonly KnowledgeRelation[],
  existing: ReadonlyMap<string, Point>,
): Map<string, Point> {
  const result = new Map<string, Point>();
  const idSet = new Set(ids);
  for (const id of ids) {
    const point = existing.get(id);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) result.set(id, { ...point });
  }
  const neighbors = new Map<string, string[]>();
  for (const relation of relations) {
    if (!idSet.has(relation.source) || !idSet.has(relation.target)) continue;
    (neighbors.get(relation.source) ?? neighbors.set(relation.source, []).get(relation.source)!).push(relation.target);
    (neighbors.get(relation.target) ?? neighbors.set(relation.target, []).get(relation.target)!).push(relation.source);
  }
  const unresolved = ids.filter((id) => !result.has(id));
  for (let pass = 0; pass < 2; pass += 1) {
    for (const id of unresolved) {
      if (result.has(id)) continue;
      const anchors = (neighbors.get(id) ?? []).map((neighbor) => result.get(neighbor)).filter((p): p is Point => Boolean(p));
      if (!anchors.length) continue;
      const anchor = anchors[0];
      const angle = hashUnit(id, 17) * Math.PI * 2;
      const radius = 24 + hashUnit(id, 31) * 22;
      result.set(id, { x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius });
    }
  }
  const remaining = ids.filter((id) => !result.has(id));
  const golden = Math.PI * (3 - Math.sqrt(5));
  remaining.forEach((id, index) => {
    const radius = 18 * Math.sqrt(index + 1);
    const angle = index * golden + hashUnit(id, 7) * 0.25;
    result.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  return result;
}
