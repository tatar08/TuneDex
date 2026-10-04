import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const POST = async (req: Request, { params }: { params: Promise<{ id: string }> }) => getBff().jobRetry(req, (await params).id);
