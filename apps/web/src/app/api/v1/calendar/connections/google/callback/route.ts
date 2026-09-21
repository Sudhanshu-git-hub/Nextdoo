import { NextResponse } from 'next/server';
import { completeGoogleCallback } from '@/server/services/calendar-connections';
import { getEnv } from '@/server/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PRD §14.3 GET /calendar/connections/google/callback — the public OAuth
 * landing. The (hashed, single-use) state is the credential; the result
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
    await completeGoogleCallback(state, code);
    return NextResponse.redirect(`${base}?calendar=connected`);
  } catch {
    return NextResponse.redirect(`${base}?calendar=error=sign_in_failed`);
  }
}
