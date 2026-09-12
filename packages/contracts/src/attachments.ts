import { z } from 'zod';
import { uuid } from './schemas';

/**
 * PRD §11.4: attachments are served only through a content-type allowlist.
 * No executables, no HTML (XSS on any future preview path), no raw
 * application/octet-stream (the client must declare a real type). Compressed
 * archives are allowed because the scanner inspects their contents.
 */
export const ATTACHMENT_CONTENT_TYPES = [
  'application/pdf',
  'application/json',
  'application/zip',
  'application/gzip',
  'application/x-7z-compressed',
  'text/plain',
  'text/csv',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];

/** Fixed extension per allowed content type — server-derived, never user input. */
export const ATTACHMENT_CONTENT_TYPE_EXTENSIONS: Record<AttachmentContentType, string> = {
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-7z-compressed': '7z',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export function isAllowedAttachmentContentType(contentType: string): contentType is AttachmentContentType {
  return (ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/** Integer file size in bytes (PostgreSQL integer column). */
const sizeBytes = z.number().int().min(1).max(2_147_483_647);

export const attachmentUploadSchema = z.object({
  taskId: uuid,
  fileName: z.string().min(1).max(300),
  contentType: z.string().min(3).max(120),
  sizeBytes,
});
export type AttachmentUploadInput = z.infer<typeof attachmentUploadSchema>;

export const attachmentListQuerySchema = z.object({
  taskId: uuid,
});

/** Signed upload/download tokens are short-lived (PRD §11.4: ≤ 15 minutes). */
export const ATTACHMENT_TOKEN_TTL_MS = 15 * 60 * 1000;
