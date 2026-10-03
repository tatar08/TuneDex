import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; action: string }> };

export const POST = async (req: Request, { params }: Ctx) => {
  const { id, action } = await params;
  return getBff().stationAction(req, id, action);
};
