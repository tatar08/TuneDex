import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const POST = async (req: Request, { params }: { params: Promise<{ release: string }> }) => getBff().configRollback(req, (await params).release);
