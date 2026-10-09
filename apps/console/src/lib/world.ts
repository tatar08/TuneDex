import type { Feature, FeatureCollection, Geometry } from 'geojson';

export type CountryShape = Feature<Geometry, { name: string }>;

let shapes: Promise<CountryShape[]> | null = null;

/**
 * Country outlines (Natural Earth 1:110m via world-atlas, public domain) bundled with the page, so the map and the
 * globe need no tile service: nothing to pay for and no third party sees where people look.
 */
export function loadCountryShapes(): Promise<CountryShape[]> {
  shapes ??= Promise.all([import('topojson-client'), import('world-atlas/countries-110m.json')]).then(([{ feature }, atlas]) => {
    const topo = (atlas.default ?? atlas) as unknown as Parameters<typeof feature>[0] & { objects: { countries: Parameters<typeof feature>[1] } };
    return (feature(topo, topo.objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>).features;
  });
  return shapes;
}
