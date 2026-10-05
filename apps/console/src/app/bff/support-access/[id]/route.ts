import { getBff } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export const DELETE = async (req: Request, { params }: { params: Promise<{ id: string }> }) => getBff().revokeSupportAccess(req, (await params).id);
