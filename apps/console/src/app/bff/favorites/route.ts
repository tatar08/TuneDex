import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const GET = (req: Request) => getBff().getFavorites(req);
