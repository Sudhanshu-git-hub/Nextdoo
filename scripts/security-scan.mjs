import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Deliberately bounded signatures, not entropy guessing or whole-program SAST.
const signatures = [
  ['SECRET_PRIVATE_KEY', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['SECRET_GITHUB', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['SECRET_PROVIDER', /\b(?:sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|ya29\.[A-Za-z0-9_-]{20,})\b/g],
  ['SECRET_JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g],
  ['SECRET_CREDENTIAL_URL', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|smtps?):\/\/[^\s/:"'`]+:[^\s/@"'`]+@[^\s"'`]+/g],
  ['SECRET_ASSIGNMENT', /\b(?:[A-Z0-9_]*(?:SECRET|PRIVATE_KEY|ACCESS_TOKEN|API_KEY|PASSWORD|CREDENTIAL)[A-Z0-9_]*|clientSecret|accessToken|refreshToken|apiKey|privateKey|webhookSecret)\b["']?\s*[:=]\s*["']([A-Za-z0-9_+/.=:@-]{16,})["']/g],
  ['SECRET_CONFIG', /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|PRIVATE_KEY|ACCESS_TOKEN|API_KEY|PASSWORD)[A-Z0-9_]*\s*[:=]\s*([A-Za-z0-9_+/.=:@-]{16,})\s*$/gm],
];
export const digest = value => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');

export function scanText(file, text) {
  // Normalize before matching: multiline regexes may consume a lone CR at EOL.
  text = text.replace(/\r\n/g, '\n');
  const findings = [];
  const add = (rule, start, value) => findings.push({ file, rule, line: text.slice(0, start).split('\n').length, fingerprint: digest(value) });
  if (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.example')) add('SECRET_ENV_FILE', 0, text);
  for (const [rule, pattern] of signatures) {
    if (rule === 'SECRET_ASSIGNMENT' && /\.[cm]?[jt]sx?$/.test(file)) continue; // AST handles code literals, including fallback values.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) add(rule, match.index, match[0]);
  }
  if (!/\.[cm]?[jt]sx?$/.test(file)) return findings;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const shells = new Set();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && /^(node:)?child_process$/.test(statement.moduleSpecifier.text)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const spec of bindings.elements) {
        if (['exec', 'execSync'].includes((spec.propertyName ?? spec.name).text)) shells.add(spec.name.text);
      }
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (statement.importClause?.name) namespaces.add(statement.importClause.name.text);
    }
  }
  // Static exceptions bind the whole file: changes to an upstream allowlist or
  // renderer implementation in that file must receive another review.
  const flag = (rule, node) => add(rule, node.getStart(source), rule.startsWith('STATIC_') ? text : node.getText(source));
  function walk(node) {
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
      const name = (ts.isBinaryExpression(node) ? node.left : node.name).getText(source);
      const initializer = ts.isBinaryExpression(node) ? node.right : node.initializer;
      if (!/public/i.test(name) && /(?:secret|password|passwordhash|accesstoken|refreshtoken|apikey|privatekey|secretaccesskey|secretkey|signingkey|credential)$/i.test(name.replace(/[^a-z0-9]/gi, '')) && initializer) {
        const literals = value => {
          if (ts.isStringLiteralLike(value) && value.text.length >= 16) flag('SECRET_LITERAL', value);
          else if (ts.isBinaryExpression(value) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind)) literals(value.right);
        };
        literals(initializer);
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const call = node.expression.getText(source);
      if (/^(?:globalThis\.|window\.)?(?:eval|Function)$/.test(call)) flag('STATIC_DYNAMIC_CODE', node);
      if (shells.has(call) || [...namespaces].some(ns => call === ns + '.exec' || call === ns + '.execSync')) flag('STATIC_SHELL_EXEC', node);
      if (call === 'sql.raw' && node.arguments?.[0] && !ts.isStringLiteralLike(node.arguments[0])) flag('STATIC_RAW_SQL_REVIEW', node);
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replace(/["']/g, '');
      const value = node.initializer.getText(source);
      if ((name === 'rejectUnauthorized' && value === 'false') || (name === 'shell' && value === 'true')) flag('STATIC_UNSAFE_CONFIG', node);
      if (name === '__html' && !(ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'renderDescription')) flag('STATIC_HTML_REVIEW', node);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left.getText(source), right = node.right.getText(source);
      if (/\.innerHTML$/.test(left)) flag('STATIC_HTML_REVIEW', node);
      if (left.includes('NODE_TLS_REJECT_UNAUTHORIZED') && /^(?:0|['"]0['"])$/.test(right)) flag('STATIC_UNSAFE_CONFIG', node);
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  return findings;
}

export function applyAllowlist(findings, entries) {
  if (!Array.isArray(entries)) throw new Error('Invalid security allowlist');
  const key = row => JSON.stringify([row.file, row.rule, row.fingerprint]);
  const seen = new Set(), allowed = new Set(), errors = [];
  for (const entry of entries) {
    if (typeof entry.file !== 'string' || /[*?\\]/.test(entry.file) || entry.file.startsWith('/') || entry.file.split('/').includes('..') || !/^(SECRET|STATIC)_[A-Z_]+$/.test(entry.rule) || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || typeof entry.reason !== 'string' || entry.reason.trim().length < 20 || seen.has(key(entry))) throw new Error('Invalid security allowlist entry');
    seen.add(key(entry));
    if (!findings.some(f => key(f) === key(entry))) errors.push({ file: entry.file, line: 1, rule: 'ALLOWLIST_STALE' });
    allowed.add(key(entry));
  }
  return [...findings.filter(f => !allowed.has(key(f))), ...errors];
}

export function scanRepository(root) {
  // Git supplies the index/working-tree names only; no history or .git contents.
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean);
  const findings = [];
  for (const file of [...new Set(names)].sort()) {
    const full = path.join(root, file);
    let stat;
    try { stat = lstatSync(full); } catch { findings.push({ file, line: 1, rule: 'SCAN_UNREADABLE' }); continue; }
    if (stat.isSymbolicLink()) { findings.push({ file, line: 1, rule: 'SCAN_SYMLINK' }); continue; }
    const bytes = readFileSync(full);
    if (bytes.includes(0) && !/(^|\/)\.env(?:\.|$)/.test(file)) continue; // Binary assets, never followed or executed.
    findings.push(...scanText(file, bytes.toString('utf8')));
  }
  const allowlist = JSON.parse(readFileSync(path.join(root, 'security-allowlist.json'), 'utf8'));
  return applyAllowlist(findings, allowlist);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const findings = scanRepository(process.cwd());
    // Never output source lines, match text, exception details, or credentials.
    for (const finding of findings) console.error(JSON.stringify({ file: finding.file, line: finding.line, rule: finding.rule }));
    console.log(`Security scan: ${findings.length} prohibited findings.`);
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error('Security scan could not complete; check repository access and allowlist format.');
    process.exitCode = 2;
  }
}
