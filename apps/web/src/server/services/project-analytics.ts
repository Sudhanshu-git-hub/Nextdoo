import { and, eq } from 'drizzle-orm';
import { projectAnalyticsQuerySchema, uuid, type ProjectAnalytics, type ProjectAnalyticsQuery } from '@nextdoo/contracts';
import { userPreferences } from '@nextdoo/db';
import { withTransaction } from '../db';
import { loadProject, type ProjectActor } from './projects';
import { getSummary } from './tracking';

/**
 * Read-only consistent snapshot: project membership, metrics and results cannot
 * tear across a move. Reports reuse the workspace-local day/week windows of the
 * shared summary, scoped to this project's current due-date cohort.
 */
export async function getProjectAnalytics(actor: ProjectActor, id: string, input: ProjectAnalyticsQuery): Promise<ProjectAnalytics> {
  uuid.parse(id);
  const query = projectAnalyticsQuerySchema.parse(input);
  return withTransaction(async (db) => {
    await loadProject(actor.workspaceId, id); // Archived is readable; foreign/deleted is not.
    const { averageScore, ...summary } = await getSummary(actor.workspaceId, query.period, query.date ?? null, id);
    const [preference] = await db.select({ value: userPreferences.value }).from(userPreferences)
      .where(and(eq(userPreferences.userId, actor.userId), eq(userPreferences.key, 'disableScores'))).limit(1);
    const scoresEnabled = preference?.value !== true;
    // Scores off strips the score figures everywhere (PRD §7.2); undefined
    // values drop out of the JSON response.
    // Scores off strips the score figures everywhere (PRD §7.2); `undefined`
    // values drop out of the JSON response.
    const days = summary.days.map(({ score, ...rest }) => ({ ...rest, score: scoresEnabled ? score : undefined }));
    return { ...summary, days, projectId: id, cohort: 'current-project-due-date', scoresEnabled,
      ...(scoresEnabled ? { averageScore } : {}),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
