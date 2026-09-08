import { and, eq } from 'drizzle-orm';
import { projectAnalyticsQuerySchema, uuid, type ProjectAnalytics, type ProjectAnalyticsQuery } from '@nextdoo/contracts';
import { userPreferences } from '@nextdoo/db';
import { withTransaction } from '../db';
import { loadProject, type ProjectActor } from './projects';
import { getSummary } from './tracking';

/** Read-only consistent snapshot: project membership, metrics and results cannot tear across a move. */
export async function getProjectAnalytics(actor: ProjectActor, id: string, input: ProjectAnalyticsQuery): Promise<ProjectAnalytics> {
  uuid.parse(id);
  const query = projectAnalyticsQuerySchema.parse(input);
  const reference = query.date ? new Date(`${query.date}T12:00:00Z`) : new Date();
  return withTransaction(async (db) => {
    await loadProject(actor.workspaceId, id); // Archived is readable; foreign/deleted is not.
    const { averageScore, ...summary } = await getSummary(actor.workspaceId, query.period, reference, id);
    const [preference] = await db.select({ value: userPreferences.value }).from(userPreferences)
      .where(and(eq(userPreferences.userId, actor.userId), eq(userPreferences.key, 'disableScores'))).limit(1);
    const scoresEnabled = preference?.value !== true;
    return { ...summary, projectId: id, timeZone: 'UTC', cohort: 'current-project-due-date', scoresEnabled,
      ...(scoresEnabled ? { averageScore } : {}),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
