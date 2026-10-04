import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ ticket: string }> };

export const GET = async (req: Request, { params }: Ctx) => getBff().deletionStatus(req, (await params).ticket);
