import { and, eq } from 'drizzle-orm';
import { reviewNotes } from '@nextdoo/db';
import { AppError } from '@nextdoo/contracts';
import { getDb } from '../db';
import { assertWorkspaceAccess } from '../auth';

/**
 * Optional review-flow notes (PRD §8.5). One note per local day per
 * workspace; `day` is the workspace-local date key, so a note stays attached
 * to the same calendar day regardless of zone or DST changes.
 */
export interface ReviewNote {
  day: string;
  body: string;
  updatedAt: string;
}

export async function getReviewNote(userId: string, workspaceId: string, day: string): Promise<ReviewNote | null> {
  await assertWorkspaceAccess(userId, workspaceId);
  const db = getDb();
  const [row] = await db
    .select()
    .from(reviewNotes)
    .where(and(eq(reviewNotes.workspaceId, workspaceId), eq(reviewNotes.day, day)))
    .limit(1);
  if (!row) return null;
  return { day: row.day, body: row.body, updatedAt: row.updatedAt.toISOString() };
}

export async function saveReviewNote(userId: string, workspaceId: string, day: string, body: string): Promise<ReviewNote> {
  await assertWorkspaceAccess(userId, workspaceId);
  const db = getDb();
  const updatedAt = new Date();
  const [row] = await db
    .insert(reviewNotes)
    .values({ workspaceId, day, body, updatedBy: userId, updatedAt })
    .onConflictDoUpdate({ target: [reviewNotes.workspaceId, reviewNotes.day], set: { body, updatedBy: userId, updatedAt } })
    .returning();
  if (!row) throw new AppError('INTERNAL_ERROR', 'The review note was not saved.');
  return { day: row.day, body: row.body, updatedAt: row.updatedAt.toISOString() };
}

export async function deleteReviewNote(userId: string, workspaceId: string, day: string): Promise<void> {
  await assertWorkspaceAccess(userId, workspaceId);
  const db = getDb();
  await db
    .delete(reviewNotes)
    .where(and(eq(reviewNotes.workspaceId, workspaceId), eq(reviewNotes.day, day)));
}
