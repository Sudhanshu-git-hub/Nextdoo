'use client';
import Link from 'next/link';

import { ProjectAnalytics } from '@/components/ProjectAnalytics';
import { ProjectBoard } from '@/components/ProjectBoard';
import { ProjectSettings, type Project } from '@/components/ProjectSettings';
import { useTaskPages } from '@/lib/use-task-pages';
import { TaskList } from '@/components/TaskList';
import { TaskPagination } from '@/components/TaskPagination';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';


/** Projects (PRD §8.3). Creation enforces the plan limit server-side. */
export function ProjectsView({ workspaceId, initialProjects }: { workspaceId: string; initialProjects: Project[] }) {
  const [editing, setEditing] = useState<Project | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    setLimitReached(false);
    try {
      const project = await api<Project>('/projects', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ workspaceId, name: name.trim() }),
      });
      setProjects((current) => [...current, project]);
      setName('');
    } catch (caught) {
      if (caught instanceof ApiError && caught.isLimit) {
        setLimitReached(true);
        setError(caught.problem.detail);
      } else {
        setError(caught instanceof ApiError ? caught.problem.detail : 'Could not create the project.');
      }
    } finally {
      setBusy(false);
    }
  }

  const editor = editing && <ProjectSettings key={editing.id} project={editing} onClose={() => setEditing(null)} onSaved={(p) => {
    setProjects((rows) => rows.map((row) => row.id === p.id ? p : row));
    setSelected((current) => current?.id === p.id ? p : current);
  }} />;
  const visible = projects.filter((p) => p.status === (showArchived ? 'ARCHIVED' : 'ACTIVE'));
  if (selected) return <><ProjectTasks key={selected.id} project={selected} workspaceId={workspaceId} back={() => setSelected(null)} manage={() => setEditing(selected)} />{editor}</>;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="subtitle">Group related work. Every project starts with a default section.</p>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
          {limitReached && (
            <>
              {' '}
              <a href="/settings">See your plan</a>.
            </>
          )}
        </div>
      )}

      <form onSubmit={create} className="card" style={{ marginBottom: 18 }}>
        <label htmlFor="project-name">New project</label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q3 planning"
            disabled={busy}
          />
          <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>

      <div className="row" role="group" aria-label="Project status filter" style={{ marginBottom: 18 }}>
        <button aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>Active projects ({projects.filter((p) => p.status === 'ACTIVE').length})</button>
        <button aria-pressed={showArchived} onClick={() => setShowArchived(true)}>Archived projects ({projects.filter((p) => p.status === 'ARCHIVED').length})</button>
      </div>
      {!visible.length ? (
        <div className="empty">
          <div className="empty-title">{showArchived ? 'No archived projects' : 'No active projects yet'}</div>
          <p>Projects are optional — unfiled work lives in your Inbox until you are ready to organise it.</p>
        </div>
      ) : (
        <div className="grid grid-2">
          {visible.map((project) => (
            <div key={project.id} className="card">
              <div className="row">
                <span
                  aria-hidden="true"
                  style={{
                    width: 10, height: 10, borderRadius: 3,
                    background: project.color ?? 'var(--accent)', display: 'inline-block',
                  }}
                />
                <button onClick={() => setSelected(project)} aria-label={`Open ${project.name}`}><strong>{project.name}</strong></button>
                <button className="btn-sm" aria-label={`Manage "${project.name}"`} onClick={() => setEditing(project)}>Settings</button>
              </div>
              {project.description && <p className="muted" style={{ marginTop: 6 }}>{project.description}</p>}
            </div>
          ))}
        </div>
      )}
      {editor}
    </>
  );
}

function ProjectTasks({ workspaceId, project, back, manage }: { workspaceId: string; project: Project; back: () => void; manage: () => void }) {
  const page = useTaskPages(workspaceId, `status=ACTIVE&projectId=${project.id}`);
  const [view, setView] = useState<'list' | 'board' | 'analytics'>('list');
  return <>
    <div className="row"><button onClick={back}>Back to projects</button><button onClick={manage}>Project settings</button><Link className="history-link" href="/task-history">Task history</Link></div><h1>{project.name}</h1>
    {project.status === 'ARCHIVED' && <div className="banner banner-warn" role="status">This project is archived. Existing tasks and reminders stay unchanged; new assignments require restoring the project.</div>}
    <p className="subtitle">Active tasks. Open a task to edit its project, tags, date or estimate.</p>
    <div className="row" role="group" aria-label="Project task view" style={{ marginBottom: 18 }}>
      <button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
      <button aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</button>
      <button aria-pressed={view === 'analytics'} onClick={() => setView('analytics')}>Project analytics</button>
    </div>
    {view === 'analytics' ? <ProjectAnalytics key={project.id} projectId={project.id} /> : view === 'board' ? <ProjectBoard project={project} tasks={page.tasks} loading={page.loading} error={page.tasks.length ? null : page.error} onChanged={page.reload} /> : <TaskList tasks={page.tasks} loading={page.loading && !page.tasks.length} error={page.tasks.length ? null : page.error} emptyTitle="No active tasks" emptyBody="Assign a task to this project from Inbox or capture with its +project name." onChanged={page.reload} />}
    {view !== 'analytics' && <TaskPagination {...page} error={page.tasks.length ? page.error : null} count={page.tasks.length} onMore={page.loadMore} onRetry={page.tasks.length ? page.loadMore : page.reload} />}
  </>;
}
