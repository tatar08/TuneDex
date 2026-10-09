'use client';

import { useEffect, useRef, useState } from 'react';
import type { GlobeInstance } from 'globe.gl';
import type { MapStation } from '@/lib/bff';

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 3D globe (globe.gl on WebGL) with the same OpenStreetMap tiles; onFail when the browser has no WebGL. */
export function WorldGlobe({ stations, selected, onSelect, onFail, fit }: { stations: MapStation[]; selected: string | null; onSelect: (s: MapStation) => void; onFail: () => void; fit: boolean }) {
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
    void import('globe.gl').then(
      ({ default: Globe }) => {
        const node = el.current;
        if (cancelled || !node) return;
        try {
          const g = new Globe(node, { animateIn: false })
            .width(node.clientWidth)
            .height(node.clientHeight)
            .backgroundColor('rgba(0,0,0,0)')
            .globeTileEngineUrl((x: number, y: number, l: number) => `https://tile.openstreetmap.org/${l}/${x}/${y}.png`)
            .globeTileEngineMaxLevel(12)
            .pointLat('lat')
            .pointLng('lon')
            .pointAltitude(0.006)
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
    globe.current
      ?.pointsData(stations)
      .pointColor((d: object) => ((d as MapStation).id === selected ? '#facc15' : '#10b981'))
      .pointRadius((d: object) => ((d as MapStation).id === selected ? 0.9 : 0.45));
  }, [ready, stations, selected]);

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
