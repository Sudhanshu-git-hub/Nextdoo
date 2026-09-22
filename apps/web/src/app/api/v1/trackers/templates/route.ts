import { authedRoute } from '@/server/http';
import { trackerTemplates } from '@/server/services/personal-trackers';
export const runtime = 'nodejs';
export const GET = authedRoute({ routeName: 'trackers.templates' }, async () => trackerTemplates());
