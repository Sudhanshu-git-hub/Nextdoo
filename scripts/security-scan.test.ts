import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllowlist, scanText } from './security-scan.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sample = 'SyntheticValue'.repeat(4);
describe('deterministic secret signatures', () => {
  it.each([
    ['SECRET_PRIVATE_KEY', ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')],
    ['SECRET_GITHUB', 'ghp_' + 'x'.repeat(36)],
    ['SECRET_PROVIDER', 'sk_live_' + sample],
    ['SECRET_PROVIDER', 'whsec_' + sample],
    ['SECRET_PROVIDER', 'AKIA' + 'A'.repeat(16)],
    ['SECRET_PROVIDER', 'ya29.' + sample],
    ['SECRET_JWT', 'eyJ' + sample + '.eyJ' + sample + '.' + sample],
    ['SECRET_CREDENTIAL_URL', 'postgres://fixture:' + sample + '@db.invalid/app'],
    ['SECRET_LITERAL', 'const clientSecret = "' + sample + '"'],
    ['SECRET_CONFIG', 'RAZORPAY_KEY_SECRET: ' + sample],
    ['SECRET_LITERAL', 'const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "' + sample + '"'],
    ['SECRET_LITERAL', 'const AWS_SECRET_ACCESS_KEY = "' + sample + '"'],
  ])('detects %s without returning its material', (rule, source) => {
    const findings = scanText('fixture.ts', source);
    expect(findings.some(f => f.rule === rule)).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(sample);
  });
  it('uses identical findings and exceptions for Windows and Linux line endings', () => {
    for (const [file, source] of [
      ['config.yml', '# fixture\nAUTH_SECRET: ' + sample + '\nPORT: 3000\n'],
      ['fixture.ts', '// fixture\nconst clientSecret = "' + sample + '";\nsql.raw(input);\n'],
    ]) {
      const linux = scanText(file, source);
      const windows = scanText(file, source.replace(/\n/g, '\r\n'));
      expect(windows).toEqual(linux);
      const entries = windows.map(f => ({ ...f, reason: 'Synthetic cross-platform scanner fixture reviewed in this test.' }));
      expect(applyAllowlist(linux, entries)).toEqual([]);
    }
  });
  it('rejects committed env variants but permits a credential-free template', () => {
    expect(scanText('config/.env.production', 'PORT=3000')[0].rule).toBe('SECRET_ENV_FILE');
    expect(scanText('.env.example', 'API_KEY=')).toEqual([]);
  });
  it('allows environment references and public identifiers', () => {
    expect(scanText('safe.ts', 'const clientSecret = process.env.GOOGLE_CLIENT_SECRET; const PUBLIC_KEY = "public-identifier-only";')).toEqual([]);
  });
});
describe('bounded static analysis', () => {
  it.each([
    ['STATIC_DYNAMIC_CODE', 'globalThis.eval(input)'],
    ['STATIC_DYNAMIC_CODE', 'new Function(input)'],
    ['STATIC_SHELL_EXEC', 'import { exec as run } from "node:child_process"; run(input)'],
    ['STATIC_SHELL_EXEC', 'import * as cp from "child_process"; cp.execSync(input)'],
    ['STATIC_UNSAFE_CONFIG', 'fetch(url, {rejectUnauthorized:false})'],
    ['STATIC_UNSAFE_CONFIG', 'spawn(bin,args,{shell:true})'],
    ['STATIC_UNSAFE_CONFIG', 'process.env.NODE_TLS_REJECT_UNAUTHORIZED="0"'],
    ['STATIC_HTML_REVIEW', 'const x = { __html: userContent };'],
    ['STATIC_RAW_SQL_REVIEW', 'sql.raw(input)'],
  ])('rejects %s', (rule, source) => expect(scanText('unsafe.ts', source).map(f => f.rule)).toContain(rule));
  it('ignores comments/string examples and accepts the reviewed renderer/parameter binding', () => {
    expect(scanText('safe.tsx', '// eval(input)\nconst example="eval(input)"; const x={__html:renderDescription(input)}; sql`select * from t where id=${id}`;')).toEqual([]);
  });
});
describe('exceptions and CLI', () => {
  it('requires exact path/rule/digest and rejects stale or broad exceptions', () => {
    const findings = scanText('example.ts', 'const clientSecret = "' + sample + '"');
    const entries = findings.map(f => ({ ...f, reason: 'Synthetic scanner fixture reviewed in this test.' }));
    expect(applyAllowlist(findings, entries)).toEqual([]);
    expect(applyAllowlist(scanText('other.ts', 'const clientSecret = "' + sample + '"'), entries).length).toBeGreaterThan(0);
    expect(applyAllowlist([], entries)[0].rule).toBe('ALLOWLIST_STALE');
    expect(() => applyAllowlist(findings, [{ ...entries[0], file: '*' }])).toThrow();
    expect(() => applyAllowlist(findings, [entries[0], entries[0]])).toThrow();
  });
  it('fails on a tracked ignored file and prints only location/rule, not its value', () => {
    const root = mkdtempSync(join(tmpdir(), 'nextdoo-security-')); roots.push(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    writeFileSync(join(root, 'security-allowlist.json'), '[]');
    writeFileSync(join(root, '.gitignore'), '.env\n');
    writeFileSync(join(root, '.env'), 'AUTH_SECRET=' + sample);
    execFileSync('git', ['add', '-f', '.env'], { cwd: root });
    const run = () => spawnSync(process.execPath, [resolve('scripts/security-scan.mjs')], { cwd: root, encoding: 'utf8' });
    const result = run();
    expect(result.status).toBe(1); expect(result.stderr).toContain('SECRET_ENV_FILE');
    expect(result.stdout + result.stderr).not.toContain(sample);
    writeFileSync(join(root, 'security-allowlist.json'), '{broken');
    expect(run().status).toBe(2);
  });
});
