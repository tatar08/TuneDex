import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const POST = (req: Request) => getBff().auditExport(req);
