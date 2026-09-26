import { authedRoute } from '@/server/http';
import { homeCard, homeSummary } from '@/server/services/home';
export const dynamic = 'force-dynamic';
export const GET = authedRoute({ routeName:'home.read' }, async (request, ctx) => {
  const card = new URL(request.url).searchParams.get('card');
  return card ? homeCard(ctx.auth, card) : homeSummary(ctx.auth);
});
