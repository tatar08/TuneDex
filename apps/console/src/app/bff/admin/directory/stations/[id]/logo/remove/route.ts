import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const POST = async (req: Request, { params }: { params: Promise<{ id: string }> }) => getBff().directoryLogo(req, (await params).id, true);
