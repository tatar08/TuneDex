import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = async (req: Request, { params }: Ctx) => getBff().revokeDevice(req, (await params).id);
