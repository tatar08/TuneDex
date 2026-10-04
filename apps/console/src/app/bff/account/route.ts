import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const DELETE = (req: Request) => getBff().deleteAccount(req);
