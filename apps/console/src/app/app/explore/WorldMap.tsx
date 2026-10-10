'use client';

import { useEffect, useRef } from 'react';
import type { LayerGroup, Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapStation } from '@/lib/bff';
import { CountryShape, loadCountryShapes } from '@/lib/world';
import { clusterPoints, clusterSize } from './cluster';
import { logoSrc } from './logo';

/** Below this many degrees a cluster's stations share one place, so zooming cannot split them; the list shows them instead. */
const SAME_PLACE = 0.02;
/** Single stations show their logo once few enough are on the map (or zoomed in), so a world view stays light. */
const LOGO_PINS_MAX = 150;
const LOGO_ZOOM = 5;


/**
 * Flat map (Leaflet over bundled country outlines, no tile service). Stations near each other on screen draw as one
 * circle with a count; zooming in splits them. Colours come from the page's CSS, so light and dark need no redraw.
 * Names go in as text nodes, never as HTML.
 */
export function WorldMap({
  stations,
  selected,
  onSelect,
  onGroup,
  fit,
  labels,
}: {
  stations: MapStation[];
  selected: string | null;
  onSelect: (s: MapStation) => void;
  onGroup: (members: MapStation[]) => void;
  fit: boolean;
  labels: { zoomIn: string; zoomOut: string; group: (n: number) => string };
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<{
    L: typeof import('leaflet');
    map: LeafletMap;
    layer: LayerGroup;
  } | null>(null);
  const pick = useRef(onSelect);
  pick.current = onSelect;
  const group = useRef(onGroup);
  group.current = onGroup;
  const text = useRef(labels);
  text.current = labels;
  const state = useRef({ stations, selected });
  state.current = { stations, selected };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([import('leaflet'), loadCountryShapes()]).then(([L, countries]) => {
      if (cancelled || !el.current) return;
      const m = L.map(el.current, {
        worldCopyJump: true,
        minZoom: 2,
        maxZoom: 10,
        attributionControl: false,
        zoomControl: false,
      }).setView([25, 40], 2);
      L.control
        .zoom({
          position: 'topright',
          zoomInTitle: text.current.zoomIn,
          zoomOutTitle: text.current.zoomOut,
        })
        .addTo(m);
      L.geoJSON(flat(countries), {
        interactive: false,
        style: { className: 'explore-land', weight: 0.7, fillOpacity: 1 },
      }).addTo(m);
      map.current = { L, map: m, layer: L.layerGroup().addTo(m) };
      m.on('zoomend', () => el.current?.dispatchEvent(new Event('map-draw')));
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
      const { stations: all, selected: on } = state.current;
      m.layer.clearLayers();
      const zoom = m.map.getZoom();
      const points = all.map((s) => ({
        ...m.map.project([s.lat, s.lon], zoom),
        item: s,
      }));
      const clusters = clusterPoints(points, 26);
      const withLogos = zoom >= LOGO_ZOOM || clusters.filter((c) => c.members.length === 1).length <= LOGO_PINS_MAX;
      for (const c of clusters) {
        const ll = m.map.unproject([c.x, c.y], zoom);
        const node = document.createElement('span');
        if (c.members.length === 1) {
          const s = c.members[0];
          const chosen = s.id === on;
          node.className = `${chosen ? 'explore-dot on' : 'explore-dot'}${withLogos ? ' logo' : ''}`;
          if (withLogos) {
            const img = document.createElement('img');
            img.src = logoSrc(s);
            img.alt = '';
            img.decoding = 'async';
            img.loading = 'lazy';
            node.append(img);
          }
          m.L.marker(ll, {
            icon: m.L.divIcon({
              html: node,
              className: 'explore-hit',
              iconSize: [40, 40],
            }),
            title: s.name,
            keyboard: true,
            zIndexOffset: chosen ? 1000 : 0,
          })
            .on('click', () => pick.current(s))
            .addTo(m.layer);
          continue;
        }
        const size = clusterSize(c.members.length);
        const holds = c.members.some((s) => s.id === on);
        node.className = holds ? 'explore-cluster on' : 'explore-cluster';
        node.style.width = node.style.height = `${size}px`;
        node.textContent = String(c.members.length);
        const bounds = m.L.latLngBounds(c.members.map((s) => [s.lat, s.lon]));
        const onePlace = bounds.getNorth() - bounds.getSouth() < SAME_PLACE && bounds.getEast() - bounds.getWest() < SAME_PLACE;
        m.L.marker(ll, {
          icon: m.L.divIcon({
            html: node,
            className: 'explore-hit',
            iconSize: [Math.max(size, 44), Math.max(size, 44)],
          }),
          title: text.current.group(c.members.length),
          keyboard: true,
          zIndexOffset: holds ? 900 : 0,
        })
          .on('click', () =>
            onePlace || zoom >= m.map.getMaxZoom()
              ? group.current(c.members)
              : m.map.fitBounds(bounds, {
                  padding: [48, 48],
                  maxZoom: zoom + 3,
                }),
          )
          .addTo(m.layer);
      }
    };
    const node = el.current;
    node?.addEventListener('map-ready', draw);
    node?.addEventListener('map-draw', draw);
    draw();
    return () => {
      node?.removeEventListener('map-ready', draw);
      node?.removeEventListener('map-draw', draw);
    };
  }, [stations, selected]);

  useEffect(() => {
    const fitNow = () => {
      const m = map.current;
      if (m && fit && stations.length)
        m.map.fitBounds(m.L.latLngBounds(stations.map((s) => [s.lat, s.lon])), {
          maxZoom: 7,
          padding: [32, 32],
        });
    };
    fitNow();
    const node = el.current;
    node?.addEventListener('map-ready', fitNow);
    return () => node?.removeEventListener('map-ready', fitNow);
  }, [stations, fit]);

  return <div ref={el} className="explore-canvas" data-testid="world-map" />;
}

type Ring = number[][];

/**
 * Shapes for a flat map. A ring that crosses the 180th meridian (Russia's far east, Fiji) would be drawn as a band
 * across the whole map, so its western points move by 360 degrees to keep it in one piece. Antarctica circles the
 * pole and holds no stations, so the flat map leaves it out.
 */
function flat(countries: CountryShape[]): CountryShape[] {
  const ring = (r: Ring): Ring => {
    const lons = r.map((p) => p[0]);
    return Math.max(...lons) - Math.min(...lons) > 180 ? r.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]) : r;
  };
  return countries
    .filter((c) => c.properties.name !== 'Antarctica')
    .map((c) => {
      const g = c.geometry;
      if (g.type === 'Polygon') return { ...c, geometry: { ...g, coordinates: g.coordinates.map(ring) } };
      if (g.type === 'MultiPolygon') return { ...c, geometry: { ...g, coordinates: g.coordinates.map((poly) => poly.map(ring)) } };
      return c;
    });
}
