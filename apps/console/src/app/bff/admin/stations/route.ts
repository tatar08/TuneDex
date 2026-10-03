import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const GET = (req: Request) => getBff().stations(req);
export const POST = (req: Request) => getBff().stations(req);
