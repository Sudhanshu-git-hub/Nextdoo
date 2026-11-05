# M8-i8 — ASVS 4.0.3 Level 2 Security Assurance Baseline

**Status: implementation complete (repository-local evidence).**
**Scope: mapped to implemented surfaces only. External/deployment controls
(TLS, managed secrets, backups) remain deployment responsibilities.**

This document converts the release-gate hardening review into a deterministic,
repository-local security assurance baseline. It maps the project's implemented
controls to the OWASP ASVS 4.0.3 Level 2 requirements, documents the CI gate
that enforces them, and records explicit boundaries between what the repository
provides and what deployment must provide.

**Method:** read-only audit of the repository. No product behavior changed.
Every claim below is verifiable in the code at the current commit.

---

## 1. Summary

| ASVS chapter | Implemented controls | Evidence |
|---|---|---|
| V1 Architecture, Design & Threat Modeling | Input validation, trusted boundaries, workspace isolation | `contracts/` (Zod), `server/services/*`, owner-scoped queries |
| V2 Authentication | Argon2id, TOTP MFA, session management, backoff, generic errors | `server/auth.ts`, `auth/mfa/*` routes, `_authentication_backoff` migration |
| V3 Session Management | Secure cookies, hashed tokens, session listing/revocation | `server/auth.ts`, `me/sessions` routes |
| V4 Access Control | Owner-scoped isolation on every read/write, workspace binding | `server/services/*`, `@nextdoo/db` queries |
| V5 Validation & Sanitization | Zod contracts, safe markdown renderer, MIME allowlists | `contracts/`, `description.ts`, `attachments/*` |
| V6 Cryptography | Argon2id, encrypted secrets, hashed tokens | `@node-rs/argon2`, `packages/db` encryption |
| V7 Error Handling & Logging | Structured logging, credential redaction, generic responses | `server/logger.ts`, `security-allowlist.json` |
| V8 Files & Attachments | ClamAV scanning, byte caps, storage outside web root | `attachments/*` routes, `createClamavScanner` |
| V9 Communications | TLS (deployment), CSP nonces, security headers | `next.config.mjs` headers, CSP nonce in layout |
| V10 Malicious Code | Dependency audit (0 advisories), deterministic secret scanner | CI `security:scan`, `pnpm audit` |
| V11 Business Logic | Idempotent requests, optimistic versioning, rate limits | `Idempotency-Key`, `RESOURCE_VERSION_CONFLICT`, `_rate_limited_until` |
| V12 HTTPS / TLS | Deployment concern (managed by platform) | Documented in `DEPLOYMENT.md` |
| V13 Malware | ClamAV integration | `attachments/[id]/download` gating |

---

## 2. Detailed mapping (key requirements)

### V2 Authentication — ✅ Implemented

| Requirement | Status | Evidence |
|---|---|---|
| 2.1.1 Password length ≥ 8 (level 1); ≥ 15 recommended | ✅ | Password policy in register route |
| 2.2.1 Argon2id or equivalent | ✅ | `@node-rs/argon2` in `server/auth.ts` |
| 2.2.2 Passwords never logged | ✅ | Credential redaction in logger |
| 2.5.1 Account lockout / backoff | ✅ | `_authentication_backoff` migration + login route |
| 2.8.1 TOTP MFA | ✅ | `auth/mfa/enrol`, `auth/mfa/confirm` routes |
| 2.8.2 MFA recovery codes | ✅ | TOTP module in `packages/core/src/totp.ts` |
| 2.10.1 Generic error responses (no user enumeration) | ✅ | Generic register/login errors |

### V3 Session Management — ✅ Implemented

| Requirement | Status | Evidence |
|---|---|---|
| 3.1.1 Secure cookie flags (production) | ✅ | `server/auth.ts` (HttpOnly, Secure, SameSite) |
| 3.2.1 Session tokens hashed at rest | ✅ | Hashed session tokens in DB |
| 3.4.1 Session revocation | ✅ | `me/sessions`, `auth/logout-all` routes |
| 3.5.1 Session listing | ✅ | `me/sessions` route |

### V4 Access Control — ✅ Implemented

| Requirement | Status | Evidence |
|---|---|---|
| 4.1.1 Every request authenticated | ✅ | `getAuth()` guard in app layout |
| 4.1.2 Owner-scoped data isolation | ✅ | All queries bind to `auth.workspaceId` |
| 4.2.1 No direct object reference without authorization | ✅ | Resource-scoped routes (`/tasks/[id]`, etc.) |

### V5 Validation & Sanitization — ✅ Implemented

| Requirement | Status | Evidence |
|---|---|---|
| 5.1.1 Input validation on all inputs | ✅ | Zod contracts in `packages/contracts` |
| 5.3.1 Output encoding / safe rendering | ✅ | Sanitized markdown renderer in `description.ts` |
| 5.4.1 File upload validation (MIME, size) | ✅ | Byte caps + MIME allowlists in attachments |

### V6 Cryptography — ✅ Implemented

| Requirement | Status | Evidence |
|---|---|---|
| 6.2.1 Strong hashing for passwords | ✅ | Argon2id |
| 6.2.2 Encryption at rest for sensitive data | ✅ | Encrypted secret sealing in `packages/db` |
| 6.3.1 Random tokens for auth | ✅ | `crypto.randomUUID()`, hashed session tokens |

### V7 Error Handling & Logging — ✅ Implemented

| Requirement | Status | Evidence |
|---|---|---|
| 7.1.1 Structured logging | ✅ | `server/logger.ts` |
| 7.1.3 No sensitive data in logs | ✅ | Credential-field redaction |
| 7.2.1 Generic user-facing errors | ✅ | `ApiError` with RFC 7807 problem details |

### V8 Files & Attachments — ✅ Implemented

| Requirement | Status | Evidence |
|---|---|---|
| 8.1.1 Virus scanning | ✅ | ClamAV via `createClamavScanner` |
| 8.1.2 Storage outside web root | ✅ | Configurable storage dir, outside `apps/web` |
| 8.3.1 File size limits | ✅ | Byte caps in upload pipeline |

### V10 Malicious Code — ✅ Implemented

| Requirement | Status | Evidence |
|---|---|---|
| 10.1.1 Dependency vulnerability scanning | ✅ | `pnpm audit` in CI → 0 advisories |
| 10.2.1 Secret detection in CI | ✅ | `scripts/security-scan.mjs` (deterministic) |

### V11 Business Logic — ✅ Implemented

| Requirement | Status | Evidence |
|---|---|---|
| 11.1.1 Idempotent requests | ✅ | `Idempotency-Key` header support |
| 11.2.1 Optimistic concurrency control | ✅ | `RESOURCE_VERSION_CONFLICT` on stale writes |
| 11.4.1 Rate limiting | ✅ | `_rate_limited_until` migration + backoff |

---

## 3. CI gate

The deterministic security scanner (`scripts/security-scan.mjs`) runs as the
**first step** in CI (before install/build), so it fails fast:

```yaml
- name: Deterministic repository secret and static security checks
  run: pnpm security:scan
```

The scanner checks:
- Private keys, GitHub tokens, provider secrets (Stripe, Razorpay, S3, JWT)
- Credential URLs in connection strings
- Secret assignments in config files
- Static analysis: `execSync`/`exec` in source (flagged for review)

The scanner is **not** a substitute for SAST/DAST or manual review. It is a
fast, deterministic, repository-local gate that catches the most common
secret-leak patterns before they reach a branch.

---

## 4. Explicit boundaries (what the repo does NOT provide)

| Control | Provider | Notes |
|---|---|---|
| TLS/HTTPS termination | Deployment platform | Fly, Vercel, Railway, or reverse proxy |
| Managed secrets storage | Deployment platform | Fly secrets, Vercel env, Docker secrets |
| Database encryption at rest | PostgreSQL/managed PG | Enable TDE on managed Postgres |
| Backups / PITR | Deployment | Documented in `MAINTENANCE.md`; `db-restore-smoke` tests the procedure |
| DDoS protection | Deployment platform | Cloudflare/Vercel/Fly edge |
| Rate limiting at edge | Deployment platform | App-level backoff exists; edge-level is deployment |
| SAST/DAST | External tools | Scanner is deterministic secret detection, not full SAST |
| Penetration testing | External | Not claimed; see `SECURITY.md` reporting process |

---

## 5. Verification

Run the scanner locally:
```bash
pnpm security:scan
```

Expected: `0 prohibited findings` (exit 0).

Run the full quality gate:
```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build
```

All gates must pass before a release cut.
