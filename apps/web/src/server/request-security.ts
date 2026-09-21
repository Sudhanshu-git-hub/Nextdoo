import { AppError } from '@nextdoo/contracts';

/** Browser CSRF boundary; native JSON clients without browser headers still work. */
export function assertRequestOrigin(request: Request): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const expected = new URL(request.url).origin;
  const configured = process.env.APP_URL ? new URL(process.env.APP_URL).origin : null;
  if (site === 'cross-site' || (origin !== null && origin !== expected && origin !== configured)
      || (origin === null && request.headers.has('cookie') && site !== 'same-origin')) {
    throw new AppError('FORBIDDEN', 'Cross-origin mutations are not permitted.');
  }
}
