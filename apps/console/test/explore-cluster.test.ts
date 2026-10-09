import { describe, expect, it } from 'vitest';
import { clusterPoints, clusterSize } from '../src/app/app/explore/cluster';

describe('explore clustering', () => {
  it('groups points within the radius and keeps the centre at their mean', () => {
    const out = clusterPoints(
      [
        { x: 100, y: 100, item: 'a' },
        { x: 110, y: 100, item: 'b' },
        { x: 400, y: 400, item: 'c' },
      ],
      26,
    );
    expect(out.map((c) => c.members)).toEqual([['a', 'b'], ['c']]);
    expect(out[0]).toMatchObject({ x: 105, y: 100 });
  });

  it('finds a neighbour across a grid cell edge', () => {
    expect(
      clusterPoints(
        [
          { x: 51, y: 10, item: 1 },
          { x: 53, y: 10, item: 2 },
        ],
        26,
      ),
    ).toHaveLength(1);
  });

  it('caps the circle size so a busy city never covers a region', () => {
    expect(clusterSize(2)).toBe(35);
    expect(clusterSize(10_000)).toBe(56);
  });
});
