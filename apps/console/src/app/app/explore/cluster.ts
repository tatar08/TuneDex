/** A group of stations drawn as one circle, or a single station when the group has one member. */
export interface Cluster<T> {
  x: number;
  y: number;
  members: T[];
}

/**
 * Greedy screen-space clustering: each point joins the first cluster whose centre is within `radius` pixels,
 * else starts a new one. Cheap enough to rerun on every zoom for the few thousand stations a page loads, and the
 * order of `points` decides ties, so the same data always draws the same circles.
 */
export function clusterPoints<T>(points: { x: number; y: number; item: T }[], radius: number): Cluster<T>[] {
  const cell = radius * 2;
  const grid = new Map<string, Cluster<T>[]>();
  const out: Cluster<T>[] = [];
  const r2 = radius * radius;
  for (const p of points) {
    const gx = Math.floor(p.x / cell);
    const gy = Math.floor(p.y / cell);
    let hit: Cluster<T> | undefined;
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        hit = grid.get(`${gx + dx}:${gy + dy}`)?.find((c) => (c.x - p.x) ** 2 + (c.y - p.y) ** 2 <= r2);
      }
    }
    if (hit) {
      // Keep the centre at the members' mean so a circle sits over its stations, not over the first one found.
      const n = hit.members.length;
      hit.x = (hit.x * n + p.x) / (n + 1);
      hit.y = (hit.y * n + p.y) / (n + 1);
      hit.members.push(p.item);
      continue;
    }
    const c: Cluster<T> = { x: p.x, y: p.y, members: [p.item] };
    out.push(c);
    const key = `${gx}:${gy}`;
    grid.set(key, [...(grid.get(key) ?? []), c]);
  }
  return out;
}

/** Circle diameter for a cluster of `n` stations: grows slowly and stops at a cap so busy cities never cover a region. */
export function clusterSize(n: number): number {
  return Math.min(56, Math.round(30 + Math.log2(n) * 5));
}
