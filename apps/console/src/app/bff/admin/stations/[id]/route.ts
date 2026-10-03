import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const GET = async (req: Request, { params }: Ctx) => getBff().station(req, (await params).id);
export const PATCH = async (req: Request, { params }: Ctx) => getBff().station(req, (await params).id);
