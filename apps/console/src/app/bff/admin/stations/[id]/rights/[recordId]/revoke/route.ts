import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; recordId: string }> };

export const POST = async (req: Request, { params }: Ctx) => {
  const { id, recordId } = await params;
  return getBff().stationRightsRevoke(req, id, recordId);
};
