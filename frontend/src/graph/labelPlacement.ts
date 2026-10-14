import type { Point } from './graphMath';
/** Screen-space placement; focus stays readable, passive labels never clip. */
export function placeNodeLabel(node: Point, labelWidth: number, width: number, height: number, focus: boolean): Point | null {
  const padding = 4; const halfHeight = 7;
  if (width < padding * 2 || height < halfHeight * 2 + padding * 2) return null;
  let x = node.x + 8; let y = node.y;
  if (focus) {
    if (x + labelWidth > width - padding) x = node.x - 8 - labelWidth;
    x = Math.max(padding, Math.min(width - padding - labelWidth, x));
    y = Math.max(padding + halfHeight, Math.min(height - padding - halfHeight, y));
  } else if (x < padding || x + labelWidth > width - padding || y - halfHeight < padding || y + halfHeight > height - padding) return null;
  return { x, y };
}
