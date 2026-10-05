import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const GET = async (req: Request, { params }: { params: Promise<{ id: string }> }) => getBff().exportFile(req, (await params).id);
