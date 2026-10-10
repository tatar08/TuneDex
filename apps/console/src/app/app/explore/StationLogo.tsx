'use client';

import { useEffect, useState } from 'react';
import { BUILT_IN_LOGO, nextLogo } from '@/lib/logo';

/**
 * A station's logo in the list: the one staff uploaded, else the station's own from its server, else our default
 * (`fallback`, or the built-in mark). Loaded only when scrolled into view, without telling the station's server
 * which page asked; a logo that does not load gives way to the next one.
 */
export function StationLogo({ logo, fallback, size }: { logo: string | null; fallback: string | null; size: number }) {
  const first = logo ?? fallback ?? BUILT_IN_LOGO;
  const [src, setSrc] = useState(first);
  useEffect(() => setSrc(first), [first]);
  return (
    <img
      className="explore-logo"
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        const next = nextLogo(src, fallback);
        if (next) setSrc(next);
      }}
    />
  );
}
