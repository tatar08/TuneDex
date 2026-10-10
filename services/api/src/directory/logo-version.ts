import { createHash } from 'node:crypto';

/** Short token that changes whenever a logo does, for `?v=` on logo links so caches can keep them for long. */
export const logoVersion = (seed: string) => createHash('sha256').update(seed).digest('base64url').slice(0, 12);
