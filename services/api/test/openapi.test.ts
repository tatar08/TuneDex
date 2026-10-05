import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml: { load: (text: string) => unknown } = require('js-yaml');
import { servedRoutes as routes } from './routes';

type Spec = { paths: Record<string, Record<string, unknown>>; components: Record<string, Record<string, unknown>> };

const servedRoutes = () => routes().map((r) => `${r.method} ${r.path}`);

const spec = yaml.load(readFileSync(join(__dirname, '..', 'openapi.proposal.yaml'), 'utf8')) as Spec;
const shape = (route: string) => route.replace(/\{[^}]+\}/g, '{}');

describe('openapi.proposal.yaml (the contract the apps build against)', () => {
  const documented = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((k) => ['get', 'put', 'post', 'patch', 'delete'].includes(k))
      .map((m) => `${m.toUpperCase()} ${path}`),
  );

  it('documents every route the API serves', () => {
    const have = new Set(documented.map(shape));
    expect(servedRoutes().filter((r) => !have.has(shape(r)))).toEqual([]);
  });

  it('documents no route the API does not serve', () => {
    const served = new Set(servedRoutes().map(shape));
    expect(documented.filter((r) => !served.has(shape(r)))).toEqual([]);
  });

  it('has no dangling $ref', () => {
    const missing: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') {
          const [, section, name] = v.match(/^#\/components\/(\w+)\/(.+)$/) ?? [];
          if (!section || !spec.components[section]?.[name]) missing.push(v);
        } else walk(v);
      }
    };
    walk(spec);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('lists exactly the error codes the API can return', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'common', 'api-error.ts'), 'utf8');
    const codes = [...source.matchAll(/^  \| '([A-Z_0-9]+)'/gm)].map((m) => m[1]).sort();
    const error = spec.components.schemas.Error as { properties: { code: { enum: string[] } } };
    expect([...error.properties.code.enum].sort()).toEqual(codes);
  });
});
