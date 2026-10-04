import { HttpStatus } from '@nestjs/common';
import { ApiError } from './api-error';

/** Doc 17 REST contract: cursor pages of 50 by default, at most 100. */
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

/** Reads `?limit=`: absent means PAGE_DEFAULT; anything but 1..max is 400. */
export function parseLimit(raw: unknown, max = PAGE_MAX, fallback = PAGE_DEFAULT): number {
  if (raw === undefined || raw === '') return fallback;
  const n = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= max)) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'limit', reason: 'out_of_range', max });
  return n;
}

/** An opaque cursor holding the sort key of the last row on the page. */
export function encodeCursor(key: string[]): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/** Reads a cursor made by encodeCursor with `parts` strings; anything else is 400. */
export function decodeCursor(raw: unknown, parts: number): string[] | null {
  if (raw === undefined || raw === '') return null;
  const bad = () => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'cursor', reason: 'malformed' });
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(raw)) throw bad();
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(raw, 'base64url').toString());
  } catch {
    throw bad();
  }
  if (!Array.isArray(key) || key.length !== parts || !key.every((k) => typeof k === 'string' && k.length <= 512)) throw bad();
  return key as string[];
}
