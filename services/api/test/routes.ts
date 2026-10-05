import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';
import { testConfig } from './harness';

export interface ServedRoute {
  method: string;
  /** "/v1/me/devices/{deviceId}" */
  path: string;
  /** Roles from @RequireRoles on the handler or its controller; null when the route has none. */
  roles: string[] | null;
}

/** Every route the API serves, read from the controllers' own decorators. */
export function servedRoutes(): ServedRoute[] {
  const mod = AppModule.forRoot({ config: testConfig('postgres://unused/unused'), pool: {} as never, keyResolver: (() => undefined) as never });
  const out = new Map<string, ServedRoute>();
  for (const controller of mod.controllers ?? []) {
    const bases = [Reflect.getMetadata(PATH_METADATA, controller) as string | string[]].flat();
    const classRoles = Reflect.getMetadata('tunedeck:roles', controller) as string[] | undefined;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined || typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
      const roles = (Reflect.getMetadata('tunedeck:roles', handler) as string[] | undefined) ?? classRoles ?? null;
      const subs = [Reflect.getMetadata(PATH_METADATA, handler) as string | string[]].flat();
      for (const base of bases) {
        for (const sub of subs) {
          const path = ('/' + [base, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')).replace(/:(\w+)/g, '{$1}');
          const r = { method: RequestMethod[method], path, roles };
          out.set(`${r.method} ${path}`, r);
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}
