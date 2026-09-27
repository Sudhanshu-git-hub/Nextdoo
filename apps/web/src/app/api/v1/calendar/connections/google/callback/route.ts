import { NextResponse } from 'next/server';
import { completeGoogleCallback } from '@/server/services/calendar-connections';
import { getEnv } from '@/server/env';
import { requireAuth } from '@/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PRD §14.3 GET /calendar/connections/google/callback — the public OAuth
 * landing. Hashed single-use state is bound to the current account; the result
 * redirects to Settings with a success/error marker the UI can surface.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const error = url.searchParams.get('error');
  const base = `${getEnv().APP_URL}/settings`;
  try {
    if (error) throw new Error(error);
    const auth = await requireAuth();
    await completeGoogleCallback(state, code, auth.userId);
    return NextResponse.redirect(`${base}?calendar=connected`);
  } catch {
    return NextResponse.redirect(`${base}?calendar=error=sign_in_failed`);
  }
}
