'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';

interface Project { id: string; name: string; color: string | null; description: string | null; taskCount?: number }

/** Projects (PRD §8.3). Creation enforces the plan limit server-side. */
export function ProjectsView({ workspaceId, initialProjects }: { workspaceId: string; initialProjects: Project[] }) {
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

      {!projects.length ? (
        <div className="empty">
          <div className="empty-title">No projects yet</div>
          <p>Projects are optional — unfiled work lives in your Inbox until you are ready to organise it.</p>
        </div>
      ) : (
        <div className="grid grid-2">
          {projects.map((project) => (
            <div key={project.id} className="card">
              <div className="row">
                <span
                  aria-hidden="true"
                  style={{
                    width: 10, height: 10, borderRadius: 3,
                    background: project.color ?? 'var(--accent)', display: 'inline-block',
                  }}
                />
                <strong>{project.name}</strong>
              </div>
              {project.description && <p className="muted" style={{ marginTop: 6 }}>{project.description}</p>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
