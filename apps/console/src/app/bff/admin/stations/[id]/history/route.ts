import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const GET = async (req: Request, { params }: Ctx) => getBff().stationHistory(req, (await params).id);
