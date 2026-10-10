/**
 * TuneDeck's own mark, built into the page: shown for a community station that has no logo until staff upload
 * another default on /admin/settings, and whenever a logo fails to load.
 */
export const BUILT_IN_LOGO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111827"/><g fill="none" stroke="#fb9f23" stroke-width="4" stroke-linecap="round"><path d="M21 22a15 15 0 0 0 0 20"/><path d="M43 22a15 15 0 0 1 0 20"/><path d="M14 16a25 25 0 0 0 0 32" opacity=".55"/><path d="M50 16a25 25 0 0 1 0 32" opacity=".55"/></g><circle cx="32" cy="32" r="6" fill="#fb9f23"/></svg>',
)}`;

/** Where the page finds an uploaded logo; the version in the address lets the browser keep it for good. */
export const logoPath = (key: string, version: string) => `/bff/directory/logos/${key}?v=${version}`;

/** The largest side of a logo the console sends; bigger pictures are scaled down in the browser first. */
export const LOGO_SIDE = 256;
const LOGO_MAX_BYTES = 256 * 1024;
const FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * What a logo falls back to, in order, when it cannot be shown: the default staff uploaded, then the built-in mark.
 * Returns the next address to try after `failed`, or null when there is nothing left.
 */
export function nextLogo(failed: string, fallback: string | null): string | null {
  if (failed === BUILT_IN_LOGO) return null;
  return fallback && failed !== fallback ? fallback : BUILT_IN_LOGO;
}

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * A picture staff chose, redrawn in the browser at 256 px at most and sent as PNG (WebP when a PNG would be too
 * big): a phone photo becomes a small logo, and whatever else the file carried (location, camera data) is left
 * behind. Throws 'type' for a file that is not a picture the browser can read, 'size' for one too large.
 */
export async function prepareLogo(file: File): Promise<{ image: string; preview: string }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('type');
  if (file.size > FILE_MAX_BYTES) throw new Error('size');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('type');
  });
  const scale = Math.min(1, LOGO_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('type');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const [type, quality] of [['image/png', undefined], ['image/webp', 0.9], ['image/jpeg', 0.85]] as const) {
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality));
    // A browser that cannot write the asked kind answers with PNG; only the kind asked for is sent.
    if (!blob || blob.type !== type || blob.size > LOGO_MAX_BYTES) continue;
    return { image: base64(new Uint8Array(await blob.arrayBuffer())), preview: canvas.toDataURL('image/png') };
  }
  throw new Error('size');
}
