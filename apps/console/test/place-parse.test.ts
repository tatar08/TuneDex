import { describe, expect, it } from 'vitest';
import { parsePlace } from '../src/app/admin/directory/DirectoryView';

describe('parsePlace', () => {
  it('reads a Google Maps copy, with a comma or a space between', () => {
    expect(parsePlace('13.7563, 100.5018')).toEqual({ lat: 13.7563, lon: 100.5018 });
    expect(parsePlace(' -33.8688 151.2093 ')).toEqual({ lat: -33.8688, lon: 151.2093 });
    expect(parsePlace('35,139')).toEqual({ lat: 35, lon: 139 });
  });

  it('refuses text, out-of-range values and 0,0', () => {
    for (const bad of ['', 'Bangkok', '91, 10', '10, 181', '0, 0', '13.7 100.5 7', '13.7,,100.5']) expect(parsePlace(bad)).toBeNull();
  });
});
