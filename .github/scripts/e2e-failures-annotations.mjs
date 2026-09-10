import { readFileSync } from 'node:fs';

/**
 * CI diagnostics: the runner's raw logs and artifacts are not always
 * retrievable (e.g. egress restrictions), but workflow annotations are
 * exposed through the API. Read the Playwright JSON report and emit each
 * failed test as a `::error file=...::` annotation so the failure is
 * diagnosable from `gh api .../check-runs/:id/annotations` alone.
 */
const path = new URL('../../apps/web/test-results/results.json', import.meta.url).pathname;
let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  console.log('::warning::No Playwright JSON report found; the E2E step failed before any test ran.');
  process.exit(0);
}
const failed = [];
for (const spec of report.suites ?? []) {
  const walk = (s) => {
    for (const t of s.specs ?? []) {
      for (const r of t.tests ?? []) {
        const bad = (r.results ?? []).filter((x) => x.status === 'failed' || x.status === 'timedOut');
        if (bad.length) failed.push({ file: t.file, line: t.line, title: t.title, errors: bad.map((x) => x.error?.message ?? x.status) });
      }
    }
    for (const child of s.suites ?? []) walk(child);
  };
  walk(spec);
}
if (!failed.length) {
  console.log('::warning::E2E step failed but the JSON report lists no failed tests (server/infra failure?).');
  process.exit(0);
}
console.log(`::error::${failed.length} E2E test(s) failed:`);
for (const f of failed) {
  const err = (f.errors[0] ?? '').replaceAll(/\u001b\[[0-9;]*m/g, '').replaceAll('\n', ' ').slice(0, 300);
  console.log(`::error file=${f.file},${f.line}:: ${f.title} :: ${err}`);
}
