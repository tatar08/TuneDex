'use client';
import { useEffect, useState } from 'react';
/** Matches the CSS guard; desktop-only presenters never claim the shared mobile dock. */
export function useDesktop() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = matchMedia('(min-width: 1101px) and (min-height: 501px)');
    const update = () => setWide(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}
