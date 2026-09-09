import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Artifact storage for generated exports (PRD §9: object storage, metadata in
 * PostgreSQL; §7.10: signed URL expiring in 24 hours).
 *
 * The interface is the switching point to managed object storage (S3 or
 * equivalent) — an operational prerequisite, not a fake provider. The default
 * implementation is a durable local file store: crash-safe (temp file + atomic
 * rename), scoped by user, gzip-compressed on the producer side.
 */
export interface ExportArtifactStore {
  /** Writes (or overwrites) the artifact for a server-generated object key. */
  write(objectKey: string, data: Uint8Array): Promise<void>;
  /** Returns the artifact bytes, or null when absent. */
  read(objectKey: string): Promise<Uint8Array | null>;
  /** Removes the artifact; absent keys are a no-op. */
  remove(objectKey: string): Promise<void>;
}

/**
 * Server-generated object keys are the only accepted input: `export-<userId>/`
 * plus a UUID and a fixed extension. There is no user-controlled path segment,
 * so traversal is impossible by construction; this check is defence in depth.
 */
export function assertExportObjectKey(objectKey: string): void {
  if (!/^export-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(json|csv)\.gz$/.test(objectKey)) {
    throw new Error('Invalid export object key.');
  }
}

/** Default root: $EXPORT_STORAGE_DIR, else ./var/exports under the app cwd. */
export function defaultExportStorageRoot(): string {
  return process.env.EXPORT_STORAGE_DIR ?? path.resolve(process.cwd(), 'var', 'exports');
}

export function createDurableFileExportStore(root?: string): ExportArtifactStore {
  const base = path.resolve(root ?? defaultExportStorageRoot());
  const resolve = (objectKey: string) => {
    assertExportObjectKey(objectKey);
    const full = path.resolve(base, objectKey);
    if (!full.startsWith(base + path.sep)) throw new Error('Invalid export object key.');
    return full;
  };

  return {
    async write(objectKey, data) {
      const full = resolve(objectKey);
      await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      const temp = `${full}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, data, { mode: 0o600 });
      try { await rename(temp, full); } catch (error) { await rm(temp, { force: true }); throw error; }
    },
    async read(objectKey) {
      try {
        return new Uint8Array(await readFile(resolve(objectKey)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async remove(objectKey) {
      await rm(resolve(objectKey), { force: true });
    },
  };
}
