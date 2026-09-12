import { requireAuth } from '@/server/auth';
import { listProjects, listTags } from '@/server/services/projects';
import { TaskBrowserView } from '@/components/views/TaskBrowserView';
export const dynamic = 'force-dynamic';
export default async function TasksPage() {
  const auth = await requireAuth();
  const [projects, tags] = await Promise.all([listProjects(auth.workspaceId), listTags(auth.workspaceId)]);
  return <TaskBrowserView key={auth.workspaceId} workspaceId={auth.workspaceId}
    projects={projects.map(({ id, name, status }) => ({ id, name: `${name}${status === 'ARCHIVED' ? ' (archived)' : ''}` }))}
    tags={tags.map(({ id, name }) => ({ id, name }))} />;
}
