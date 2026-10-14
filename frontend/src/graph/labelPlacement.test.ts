import { expect, it } from 'vitest';
import { placeNodeLabel } from './labelPlacement';
it('hides clipped passive labels and repositions a focus title', () => {
  expect(placeNodeLabel({ x: 350, y: 100 }, 120, 390, 300, false)).toBeNull();
  expect(placeNodeLabel({ x: 350, y: 100 }, 120, 390, 300, true)).toEqual({ x: 222, y: 100 });
  expect(placeNodeLabel({ x: 2, y: 1 }, 380, 390, 300, true)).toEqual({ x: 4, y: 11 });
  expect(placeNodeLabel({ x: 20, y: 1 }, 50, 390, 300, false)).toBeNull();
  expect(placeNodeLabel({ x: 20, y: 100 }, 50, 390, 300, false)).toEqual({ x: 28, y: 100 });
});
