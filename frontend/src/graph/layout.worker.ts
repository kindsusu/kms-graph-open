/// <reference lib="webworker" />
import { createLayoutSimulation, suggestedTickCount, type LayoutLink, type LayoutNode } from './layoutSimulation';

interface LayoutRequest { type: 'layout'; generation: number; nodes: Array<{ id: string; degree: number; x: number; y: number; fixed?: boolean }>; links: Array<{ source: string; target: string }> }

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  if (event.data.type !== 'layout') return;
  const { generation } = event.data;
  const nodes: LayoutNode[] = event.data.nodes.map((node) => ({ ...node }));
  const links: LayoutLink[] = event.data.links.map((link) => ({ ...link }));
  try {
    const simulation = createLayoutSimulation(nodes, links);
    const totalTicks = suggestedTickCount(nodes.length);
    let completed = 0;
    const runChunk = () => {
      const end = Math.min(totalTicks, completed + 24);
      while (completed < end) { simulation.tick(); completed += 1; }
      const positions = nodes.map((node) => ({ id: node.id, x: node.x ?? 0, y: node.y ?? 0 }));
      if (completed < totalTicks) {
        self.postMessage({ type: 'progress', generation, positions });
        setTimeout(runChunk, 0);
      } else {
        simulation.stop();
        self.postMessage({ type: 'done', generation, positions });
      }
    };
    runChunk();
  } catch (error) {
    self.postMessage({ type: 'error', generation, message: error instanceof Error ? error.message : String(error) });
  }
};

export {};
