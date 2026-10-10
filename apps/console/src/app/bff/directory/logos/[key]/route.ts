import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const GET = async (req: Request, { params }: { params: Promise<{ key: string }> }) => getBff().getLogo(req, (await params).key);
