type Tasks = readonly (() => Promise<unknown>)[];

/**
 * Like Promise.all over thunks, but runs at most `limit` at a time, so one page load cannot take every
 * database connection in the pool. Results keep the order (and tuple types) of `tasks`.
 */
export async function allLimited<T extends Tasks | []>(tasks: T, limit: number): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results = new Array<unknown>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
