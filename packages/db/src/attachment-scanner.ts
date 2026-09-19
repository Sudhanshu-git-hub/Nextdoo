import { spawn } from 'node:child_process';

/**
 * Attachment malware scanning (PRD §6.8 "async scan", §14 `attachment.scan`,
 * §11.4 threat model: "Attachment malware served to users" — control: scan
 * status gating + quarantine).
 *
 * The engine is ClamAV, invoked through its `clamscan` CLI: a real,
 * self-hosted antivirus engine (no external provider account or credential
 * required). The `AttachmentScanner` interface is the switching point to a
 * managed scanner service in production.
 *
 * Fail-closed contract: `scan` resolves only when the engine reports a
 * definitive verdict. Any engine error, non-zero unexpected exit, timeout, or
 * "scanning warning" (exit 2) rejects — the caller retries and, after the
 * budget, quarantines. A file is never marked CLEAN without a successful
 * engine scan.
 */
export interface AttachmentScanVerdict {
  infected: boolean;
  /** Detected signature name (e.g. "Eicar-Signature") when infected. */
  virusName?: string;
  engine: 'clamav';
}

export interface AttachmentScanner {
  /** Scans the file at `filePath`. Resolves on a definitive verdict only. */
  scan(filePath: string): Promise<AttachmentScanVerdict>;
}

export type ClamavBin = string;

export function defaultClamavBin(): ClamavBin {
  return process.env.ATTACHMENT_SCAN_BIN ?? 'clamscan';
}

/** clamscan exit codes: 0 clean, 1 infected, 2 warning (incomplete scan). */
const EXIT_CLEAN = 0;
const EXIT_INFECTED = 1;
const EXIT_WARNING = 2;
const SCAN_TIMEOUT_MS = 120_000;

export function createClamavScanner(bin: ClamavBin = defaultClamavBin()): AttachmentScanner {
  return {
    async scan(filePath: string): Promise<AttachmentScanVerdict> {
      const { code, stdout } = await runClamscan(bin, filePath);
      if (code === EXIT_CLEAN) return { infected: false, engine: 'clamav' };
      if (code === EXIT_INFECTED) {
        const found = /:\s*(.+?)\s+FOUND/i.exec(stdout);
        return { infected: true, virusName: found?.[1]?.trim() ?? 'unknown', engine: 'clamav' };
      }
      // Exit 2 = engine warning (file could not be fully scanned), and any
      // other code: no definitive verdict. Fail closed.
      throw new Error(
        code === EXIT_WARNING ? 'ATTACHMENT_SCAN_WARNING' : `ATTACHMENT_SCAN_FAILED:${code}`,
      );
    },
  };
}

function runClamscan(bin: string, filePath: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--no-summary', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('ATTACHMENT_SCAN_TIMEOUT')));
    }, SCAN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new Error(`ATTACHMENT_SCAN_UNAVAILABLE: ${error.code ?? error.message}`)));
    });
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? -1, stdout }));
    });
  });
}

/**
 * Scanner health check (PRD §19 threat table: "scanner health check").
 * Resolves true only when the engine binary runs and reports its version.
 */
export async function attachmentScannerHealthy(bin: ClamavBin = defaultClamavBin()): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let version = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { version += chunk.toString('utf8'); });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0 && version.trim().length > 0));
  });
}
