import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const GET = (req: Request) => getBff().getSettings(req);
export const PATCH = (req: Request) => getBff().patchSettings(req);
