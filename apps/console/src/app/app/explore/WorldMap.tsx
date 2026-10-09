'use client';

import { useEffect, useRef } from 'react';
import type { LayerGroup, Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapStation } from '@/lib/bff';
import { loadCountryShapes } from '@/lib/world';

/** Flat map (Leaflet over bundled country outlines, no tile service). Names go in as text nodes, never as HTML. */
export function WorldMap({ stations, selected, onSelect, fit }: { stations: MapStation[]; selected: string | null; onSelect: (s: MapStation) => void; fit: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<{ L: typeof import('leaflet'); map: LeafletMap; layer: LayerGroup } | null>(null);
  const pick = useRef(onSelect);
  pick.current = onSelect;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([import('leaflet'), loadCountryShapes()]).then(([L, countries]) => {
      if (cancelled || !el.current) return;
      const m = L.map(el.current, { worldCopyJump: true, minZoom: 2, maxZoom: 9, attributionControl: false }).setView([20, 10], 2);
      L.geoJSON(countries, { interactive: false, style: { color: '#334155', weight: 0.7, fillColor: '#1e3a2f', fillOpacity: 1 } }).addTo(m);
      map.current = { L, map: m, layer: L.layerGroup().addTo(m) };
      el.current.dispatchEvent(new Event('map-ready'));
    });
    return () => {
      cancelled = true;
      map.current?.map.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const draw = () => {
      const m = map.current;
      if (!m) return;
      m.layer.clearLayers();
      for (const s of stations) {
        const label = document.createElement('span');
        label.textContent = s.name;
        const on = s.id === selected;
        m.L.circleMarker([s.lat, s.lon], { radius: on ? 9 : 5, weight: on ? 3 : 1, color: on ? '#0f172a' : '#047857', fillColor: on ? '#facc15' : '#10b981', fillOpacity: 0.85 })
          .bindTooltip(label)
          .on('click', () => pick.current(s))
          .addTo(m.layer);
      }
      if (fit && stations.length) m.map.fitBounds(m.L.latLngBounds(stations.map((s) => [s.lat, s.lon])), { maxZoom: 7, padding: [24, 24] });
    };
    draw();
    const node = el.current;
    node?.addEventListener('map-ready', draw);
    return () => node?.removeEventListener('map-ready', draw);
  }, [stations, selected, fit]);

  return <div ref={el} className="explore-canvas" data-testid="world-map" />;
}
