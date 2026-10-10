import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const POST = async (req: Request, { params }: { params: Promise<{ key: string }> }) => getBff().directoryLogoSet(req, (await params).key);
