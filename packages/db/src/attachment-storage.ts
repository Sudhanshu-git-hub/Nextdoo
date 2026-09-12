import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Object storage for attachment file data (PRD §9: object storage, metadata in
 * PostgreSQL; §6.8: signed URLs with expiration).
 *
 * The interface is the switching point to managed object storage (S3 or
 * equivalent) — an operational prerequisite, not a fake provider. The default
 * implementation is a durable local file store: crash-safe (temp file + atomic
 * rename), scoped by workspace.
 */
export interface AttachmentObjectStore {
  /** Writes (or overwrites) the file for a server-generated object key. */
  write(objectKey: string, data: Uint8Array): Promise<void>;
  /** Returns the file bytes, or null when absent. */
  read(objectKey: string): Promise<Uint8Array | null>;
  /** Removes the file; absent keys are a no-op. */
  remove(objectKey: string): Promise<void>;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OBJECT_KEY = new RegExp(
  `^attach-${UUID}/${UUID}\\.(pdf|json|zip|gz|7z|txt|csv|md|png|jpg|gif|webp|docx|xlsx|pptx)$`,
);

/**
 * Server-generated object keys are the only accepted input:
 * `attach-<workspaceId>/<attachmentId>.<ext>` with a fixed extension set.
 * There is no user-controlled path segment, so traversal is impossible by
 * construction; this check is defence in depth.
 */
export function assertAttachmentObjectKey(objectKey: string): void {
  if (!OBJECT_KEY.test(objectKey)) throw new Error('Invalid attachment object key.');
}

/** Default root: $ATTACHMENT_STORAGE_DIR, else ./var/attachments under the app cwd. */
export function defaultAttachmentStorageRoot(): string {
  return process.env.ATTACHMENT_STORAGE_DIR ?? path.resolve(process.cwd(), 'var', 'attachments');
}

export function createDurableFileAttachmentStore(root?: string): AttachmentObjectStore {
  const base = path.resolve(root ?? defaultAttachmentStorageRoot());
  const resolve = (objectKey: string) => {
    assertAttachmentObjectKey(objectKey);
    const full = path.resolve(base, objectKey);
    if (!full.startsWith(base + path.sep)) throw new Error('Invalid attachment object key.');
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
