import { expect, it, vi } from 'vitest';

it('withholds Google even with credentials and rejects webhook input before parsing',async()=>{
  vi.stubEnv('GOOGLE_CALENDAR_ENABLED','false');
  vi.stubEnv('GOOGLE_CLIENT_ID','fixture-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET','fixture');
  vi.resetModules();
  try {
    const {googleConfig}=await import('./services/calendar-connections');
    expect(googleConfig()).toBeNull();
    const {POST}=await import('../app/api/v1/calendar/webhook/route');
    const request=new Request('http://localhost/api/v1/calendar/webhook',{method:'POST',body:'not json'});
    const response=await POST(request);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('PROVIDER_UNAVAILABLE');
    expect(request.bodyUsed).toBe(false);
  } finally {vi.unstubAllEnvs();vi.resetModules();}
});
