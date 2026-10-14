import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';

export interface LayoutNode extends SimulationNodeDatum { id: string; degree: number; fixed?: boolean }
export interface LayoutLink extends SimulationLinkDatum<LayoutNode> { source: string | LayoutNode; target: string | LayoutNode }

export function createLayoutSimulation(nodes: LayoutNode[], links: LayoutLink[]): Simulation<LayoutNode, LayoutLink> {
  for (const node of nodes) {
    if (node.fixed) { node.fx = node.x; node.fy = node.y; }
  }
  return forceSimulation(nodes)
    .stop()
    .alpha(1)
    .alphaMin(0.012)
    .alphaDecay(0.025)
    .velocityDecay(0.34)
    .force('link', forceLink<LayoutNode, LayoutLink>(links).id((node) => node.id).distance(42).strength(0.16))
    .force('charge', forceManyBody().strength((node) => -22 - Math.min(16, (node as LayoutNode).degree * 1.2)).distanceMax(240))
    .force('collide', forceCollide<LayoutNode>().radius((node) => 7 + Math.min(3, Math.sqrt(node.degree))).strength(0.75))
    .force('center', forceCenter(0, 0).strength(0.035));
}

export function suggestedTickCount(nodeCount: number): number {
  return Math.min(360, Math.max(180, Math.ceil(Math.log2(nodeCount + 1) * 38)));
}
