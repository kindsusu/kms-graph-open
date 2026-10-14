import { describe, expect, it } from 'vitest';
import type { KnowledgeItem, KnowledgeRelation } from '../model';
import { fitTransform, isDirectionalRelation, labelTier, nearestNode, nodeRadiusForDegree, relationDisplayLabel, seedPositions, visibleNeighborhood, zoomAt } from './graphMath';
import { createLayoutSimulation, suggestedTickCount, type LayoutLink, type LayoutNode } from './layoutSimulation';

const item = (id: string): KnowledgeItem => ({ id, title: id, kind: 'document', subtype: '', description: '', owner: '', department: '', domain: '', tags: [] });
const edge = (source: string, target: string): KnowledgeRelation => ({ id: `${source}-${target}`, source, target, type: 'related', label: '' });

describe('viewport math', () => {
  it('keeps the world point under the cursor while zooming', () => {
    const before = { x: 14, y: -8, k: .5 }; const cursor = { x: 220, y: 90 };
    const world = { x: (cursor.x - before.x) / before.k, y: (cursor.y - before.y) / before.k };
    const after = zoomAt(before, cursor, 2);
    expect(after.x + world.x * after.k).toBeCloseTo(cursor.x);
    expect(after.y + world.y * after.k).toBeCloseTo(cursor.y);
  });

  it('returns finite transforms for empty and narrow viewports', () => {
    expect(fitTransform([], 0, 0)).toEqual({ x: 0, y: 0, k: 1 });
    const fit = fitTransform([{ x: -1000, y: 0 }, { x: 1000, y: 0 }], 20, 600, 40);
    expect(Object.values(fit).every(Number.isFinite)).toBe(true);
    expect(fit.k).toBeGreaterThanOrEqual(.18);
  });

  it('picks a tiny node through the minimum 10px hit target', () => {
    const nodes = [{ id: 'a', x: 0, y: 0 }];
    expect(nearestNode(nodes, { x: 9, y: 0 }, 1)?.id).toBe('a');
    expect(nearestNode(nodes, { x: 11, y: 0 }, 1)).toBeNull();
  });
});

describe('graph filtering', () => {
  const items = ['a', 'b', 'c', 'd'].map(item);
  const relations = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
  it('applies the visible filter before undirected BFS', () => {
    const allowed = new Set(['a', 'b', 'd']);
    expect([...visibleNeighborhood(items, relations, allowed, 'a', 2)].sort()).toEqual(['a', 'b']);
    expect([...visibleNeighborhood(items, relations, allowed, 'a', 0)].sort()).toEqual(['a', 'b', 'd']);
  });
});

describe('graph visibility encoding', () => {
  const adjacency = new Map([
    ['selected', new Set(['neighbor'])], ['neighbor', new Set(['selected'])],
    ['other', new Set(['hovered'])], ['hovered', new Set(['other'])],
  ]);

  it('keeps focus labels ahead of direct neighbors and other nodes', () => {
    expect(labelTier('selected', 'selected', 'hovered', adjacency)).toBe('focus');
    expect(labelTier('hovered', 'selected', 'hovered', adjacency)).toBe('focus');
    expect(labelTier('other', 'selected', 'hovered', adjacency)).toBe('neighbor');
    expect(labelTier('neighbor', 'selected', 'hovered', adjacency)).toBe('other');
  });

  it('uses a bounded, monotonic size for unique neighbor counts', () => {
    const sizes = [0, 1, 2, 8, 80, 800].map(nodeRadiusForDegree);
    expect(sizes.every((size, index) => index === 0 || size >= sizes[index - 1])).toBe(true);
    expect(nodeRadiusForDegree(800)).toBeLessThanOrEqual(5.5);
  });

  it('keeps arrows for directional relations and supplies human labels', () => {
    expect(isDirectionalRelation('references')).toBe(true);
    expect(isDirectionalRelation('related')).toBe(false);
    expect(isDirectionalRelation('uses_with')).toBe(false);
    expect(relationDisplayLabel({ id: 'r', source: 'a', target: 'b', type: 'based_on', label: '  ' })).toBe('근거로 함');
  });
});

describe('layout', () => {
  it('preserves existing coordinates and seeds a linked new node nearby', () => {
    const existing = new Map([['a', { x: 120, y: -40 }]]);
    const seeded = seedPositions(['a', 'b'], [edge('a', 'b')], existing);
    expect(seeded.get('a')).toEqual({ x: 120, y: -40 });
    expect(Math.hypot(seeded.get('b')!.x - 120, seeded.get('b')!.y + 40)).toBeLessThan(47);
  });

  it.each([150, 1000])('stabilizes %i nodes to finite coordinates', (count) => {
    const nodes: LayoutNode[] = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, degree: i ? 2 : 1, x: Math.cos(i) * Math.sqrt(i) * 12, y: Math.sin(i) * Math.sqrt(i) * 12 }));
    const links: LayoutLink[] = Array.from({ length: count - 1 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
    const started = performance.now();
    const simulation = createLayoutSimulation(nodes, links);
    simulation.tick(suggestedTickCount(count)); simulation.stop();
    const elapsed = performance.now() - started;
    console.info(`[layout measurement] ${count} nodes / ${links.length} edges / ${suggestedTickCount(count)} ticks: ${elapsed.toFixed(1)} ms (Node/Vitest, synchronous test)`);
    expect(nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  }, 15000);

  it('keeps fixed existing nodes unchanged while positioning additions', () => {
    const nodes: LayoutNode[] = [{ id: 'old', degree: 1, x: 70, y: -25, fixed: true }, { id: 'new', degree: 1, x: 90, y: -20 }];
    const simulation = createLayoutSimulation(nodes, [{ source: 'old', target: 'new' }]);
    simulation.tick(220).stop();
    expect(nodes[0].x).toBe(70); expect(nodes[0].y).toBe(-25);
    expect(Number.isFinite(nodes[1].x) && Number.isFinite(nodes[1].y)).toBe(true);
  });

  it('deterministically separates nodes that start at identical coordinates', () => {
    const run = () => {
      const nodes: LayoutNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `same${i}`, degree: 7, x: 0, y: 0 }));
      const links: LayoutLink[] = Array.from({ length: 7 }, (_, i) => ({ source: 'same0', target: `same${i + 1}` }));
      createLayoutSimulation(nodes, links).tick(220).stop();
      return nodes.map((node) => ({ x: node.x!, y: node.y! }));
    };
    const first = run(); const second = run();
    expect(first.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(new Set(first.map((node) => `${node.x.toFixed(3)},${node.y.toFixed(3)}`)).size).toBeGreaterThan(1);
    expect(second).toEqual(first);
  });

  it('measures the 1000-node demo-like two-links-per-node topology', () => {
    const count = 1000;
    const nodes: LayoutNode[] = Array.from({ length: count }, (_, i) => ({ id: `d${i}`, degree: 4, x: Math.cos(i * 2.4) * Math.sqrt(i) * 10, y: Math.sin(i * 2.4) * Math.sqrt(i) * 10 }));
    const links: LayoutLink[] = [];
    for (let i = 1; i < count; i += 1) {
      links.push({ source: `d${i}`, target: `d${Math.floor((i - 1) / 2)}` });
      links.push({ source: `d${i}`, target: `d${(i * 37 + 11) % i}` });
    }
    const started = performance.now();
    createLayoutSimulation(nodes, links).tick(suggestedTickCount(count)).stop();
    const elapsed = performance.now() - started;
    console.info(`[layout measurement] ${count} nodes / ${links.length} demo-like edges / ${suggestedTickCount(count)} ticks: ${elapsed.toFixed(1)} ms (Node/Vitest, synchronous test)`);
    expect(nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  }, 15000);
});
