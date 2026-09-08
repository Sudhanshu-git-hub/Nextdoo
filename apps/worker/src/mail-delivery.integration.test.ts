import { createServer, type Server } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sql as query } from 'drizzle-orm';
import { requireTestDatabase } from '../../../tests/database';
import { db, sql } from './runtime';
import { deliverMail } from './mail-delivery';
import { sendMail } from '../../web/src/server/mailer';
import { registerUser } from '../../web/src/server/services/accounts';
await requireTestDatabase();
let server: Server, port: number;
const received: string[] = [];
beforeAll(async () => {
  server = createServer((socket) => {
    socket.setEncoding('utf8'); socket.write('220 localhost SMTP test sink\r\n');
    let buffer = '', data = false, message = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const i = buffer.indexOf('\r\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        if (data) {
          if (line === '.') { received.push(message); message = ''; data = false; socket.write('250 queued\r\n'); }
          else message += line + '\r\n';
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250-localhost\r\n250 SIZE 1048576\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  vi.stubEnv('SMTP_URL', `smtp://127.0.0.1:${port}`);
});
afterAll(async () => { vi.unstubAllEnvs(); await sql.end(); await new Promise<void>((resolve) => server.close(() => resolve())); });
async function queued() {
  const u = await registerUser({ email: `smtp-${randomUUID()}@test.local`, name: null, passwordHash: 'test', timeZone: 'UTC' });
  await sendMail('password-changed', u.email);
  const [row] = await db.execute(query`select * from mail_deliveries where user_id=${u.id}`);
  expect(row).toBeDefined();
  expect(String(row!.encrypted_message)).not.toContain(u.email);
  await db.execute(query`update mail_deliveries set created_at='1970-01-01' where id=${row!.id}`);
  return String(row!.id);
}
it('real SMTP acceptance creates a SENT ledger exactly once under concurrent passes', async () => {
  const id = await queued();
  await Promise.all([deliverMail(1), deliverMail(1)]);
  const [row] = await db.execute(query`select * from mail_deliveries where id=${id}`);
  expect(row!.status).toBe('SENT'); expect(row!.encrypted_message).toBe('');
  expect(received.filter((m) => m.includes(`<${id}@nextdoo.local>`))).toHaveLength(1);
});
it('a crashed lease is recovered from durable state by a subsequent worker pass', async () => {
  const id = await queued();
  await db.execute(query`update mail_deliveries set status='PROCESSING',attempts=1,lease_token=${randomUUID()},lease_until=now()-interval '1 minute' where id=${id}`);
  await deliverMail(1);
  const [row] = await db.execute(query`select * from mail_deliveries where id=${id}`);
  expect(row!.status).toBe('SENT'); expect(row!.attempts).toBe(2);
});
it('SMTP failure persists bounded retries and a terminal failure without claiming delivery', async () => {
  const id = await queued();
  vi.stubEnv('SMTP_URL', 'smtp://127.0.0.1:1');
  try {
    for (let i = 0; i < 5; i++) {
      await db.execute(query`update mail_deliveries set next_attempt_at=now()-interval '1 second' where id=${id}`);
      await deliverMail(1);
    }
    const [row] = await db.execute(query`select * from mail_deliveries where id=${id}`);
    expect(row!.status).toBe('FAILED'); expect(row!.attempts).toBe(5); expect(row!.sent_at).toBeNull();
    expect(row!.last_error).toBe('SMTP_DELIVERY_FAILED');
  } finally { vi.stubEnv('SMTP_URL', `smtp://127.0.0.1:${port}`); }
});
