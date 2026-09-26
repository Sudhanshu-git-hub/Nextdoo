import { z } from 'zod';
import { authedRoute } from '@/server/http';
import { listTimeEntries } from '@/server/services/timers';
export const dynamic='force-dynamic';
export const GET=authedRoute({routeName:'time-entries.list'},async(request,ctx)=>listTimeEntries(ctx.auth,z.string().uuid().parse(new URL(request.url).searchParams.get('taskId'))));
