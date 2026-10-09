'use client';

import { useEffect, useRef, useState } from 'react';
import type { GlobeInstance } from 'globe.gl';
import type { MapStation } from '@/lib/bff';
import { loadCountryShapes } from '@/lib/world';

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Globe colours for the page's light or dark look (WebGL cannot read CSS variables). */
export interface GlobePalette {
  ocean: string;
  land: string;
  border: string;
  dot: string;
  dotOn: string;
  glow: string;
}

/**
 * 3D globe (globe.gl on WebGL) drawing the same bundled country outlines; onFail when the browser has no WebGL.
 * It never spins by itself: it moves only when the viewer drags or picks a station.
 */
export function WorldGlobe({
  stations,
  selected,
  onSelect,
  onFail,
  fit,
  palette,
}: {
  stations: MapStation[];
  selected: string | null;
  onSelect: (s: MapStation) => void;
  onFail: () => void;
  fit: boolean;
  palette: GlobePalette;
}) {
  const el = useRef<HTMLDivElement>(null);
  const globe = useRef<GlobeInstance | null>(null);
  const [ready, setReady] = useState(false);
  const pick = useRef(onSelect);
  pick.current = onSelect;
  const fail = useRef(onFail);
  fail.current = onFail;

  useEffect(() => {
    let cancelled = false;
    let resize: ResizeObserver | null = null;
    void Promise.all([import('globe.gl'), loadCountryShapes()]).then(
      ([{ default: Globe }, countries]) => {
        const node = el.current;
        if (cancelled || !node) return;
        try {
          const g = new Globe(node, { animateIn: false })
            .width(node.clientWidth)
            .height(node.clientHeight)
            .backgroundColor('rgba(0,0,0,0)')
            .showGraticules(false)
            .polygonsData(countries)
            .polygonSideColor(() => 'rgba(0,0,0,0)')
            .polygonAltitude(0.004)
            .pointLat('lat')
            .pointLng('lon')
            .pointAltitude(0.006)
            // Thousands of stations: no grow-in animation and fewer sides per dot keep the globe smooth.
            .pointsTransitionDuration(0)
            .pointResolution(6)
            .pointLabel((d: object) => escape((d as MapStation).name))
            .onPointClick((d: object) => pick.current(d as MapStation));
          globe.current = g;
          resize = new ResizeObserver(() => g.width(node.clientWidth).height(node.clientHeight));
          resize.observe(node);
          setReady(true);
        } catch {
          fail.current();
        }
      },
      () => fail.current(),
    );
    return () => {
      cancelled = true;
      resize?.disconnect();
      globe.current?._destructor();
      globe.current = null;
    };
  }, []);

  useEffect(() => {
    const g = globe.current;
    if (!g) return;
    (g.globeMaterial() as unknown as { color: { set(c: string): void } }).color.set(palette.ocean);
    g.polygonCapColor(() => palette.land)
      .polygonStrokeColor(() => palette.border)
      .atmosphereColor(palette.glow);
  }, [ready, palette]);

  useEffect(() => {
    globe.current
      ?.pointsData(stations)
      .pointColor((d: object) => ((d as MapStation).id === selected ? palette.dotOn : palette.dot))
      .pointRadius((d: object) => ((d as MapStation).id === selected ? 1.1 : 0.45));
  }, [ready, stations, selected, palette]);

  useEffect(() => {
    if (!fit || !stations.length) return;
    const lat = stations.reduce((a, s) => a + s.lat, 0) / stations.length;
    const lng = stations.reduce((a, s) => a + s.lon, 0) / stations.length;
    globe.current?.pointOfView({ lat, lng, altitude: 1.6 }, 800);
  }, [ready, stations, fit]);

  useEffect(() => {
    const s = stations.find((x) => x.id === selected);
    if (s) globe.current?.pointOfView({ lat: s.lat, lng: s.lon, altitude: 1.2 }, 800);
  }, [ready, selected, stations]);

  return <div ref={el} className="explore-canvas globe" data-testid="world-globe" />;
}
