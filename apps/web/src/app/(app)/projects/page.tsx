import { requireAuth } from '@/server/auth';
import { listProjects } from '@/server/services/projects';
import { ProjectsView } from '@/components/views/ProjectsView';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const auth = await requireAuth();
  const projects = await listProjects(auth.workspaceId);
  return <ProjectsView workspaceId={auth.workspaceId} initialProjects={projects} />;
}
