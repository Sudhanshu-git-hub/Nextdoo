'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Task } from './api';
import { cacheTasks, readCachedTasks } from './offline-queue';
interface Page { data: Task[]; pagination: { next_cursor: string | null; has_more: boolean } }
interface State { key: string; tasks: Task[]; next: string | null; hasMore: boolean; loading: boolean; error: string | null; stale: boolean }
const empty = (key: string): State => ({ key, tasks: [], next: null, hasMore: false, loading: true, error: null, stale: false });
/** Bounded pages, duplicate-click prevention and late-response/account-switch isolation. */
export function useTaskPages(workspaceId: string, filters: string, cachedFallback = false) {
  const key = `${workspaceId}:${filters}`;
  const [state, setState] = useState<State>(() => empty(key));
  const currentKey = useRef(key); currentKey.current = key;
  const snapshot = useRef(state); snapshot.current = state;
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const load = useCallback(async (more: boolean) => {
    if (more && (busy.current || snapshot.current.key !== key || !snapshot.current.hasMore)) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller; busy.current = true;
    const previous = more ? snapshot.current : empty(key);
    setState({ ...previous, loading: true, error: null });
    try {
      const cursor = more && previous.next ? `&cursor=${encodeURIComponent(previous.next)}` : '';
      const result = await api<Page>(`/tasks?workspaceId=${workspaceId}&${filters}&limit=50${cursor}`, { signal: controller.signal });
      if (controller.signal.aborted || currentKey.current !== key) return;
      const tasks = [...new Map([...previous.tasks, ...result.data].map((t) => [t.id, t])).values()];
      setState({ key, tasks, next: result.pagination.next_cursor, hasMore: result.pagination.has_more, loading: false, error: null, stale: false });
      if (cachedFallback) void cacheTasks(workspaceId, tasks).catch(() => {});
    } catch (error) {
      if (controller.signal.aborted || currentKey.current !== key) return;
      if (!more && cachedFallback) {
        const cached = await readCachedTasks<Task>(workspaceId).catch(() => []);
        if (controller.signal.aborted || currentKey.current !== key) return;
        const until = new URLSearchParams(filters).get('dueBefore');
        const tasks = cached.filter((t) => t.status === 'ACTIVE' && (!until || t.dueAt && t.dueAt <= until));
        if (tasks.length) { setState({ ...empty(key), tasks, stale: true, loading: false }); return; }
      }
      setState({ ...previous, loading: false, error: error instanceof ApiError ? error.problem.detail : 'Could not load your tasks. Please retry.' });
    } finally { if (request.current === controller) busy.current = false; }
  }, [key, workspaceId, filters, cachedFallback]);
  const reload = useCallback(() => load(false), [load]);
  const loadMore = useCallback(() => load(true), [load]);
  useEffect(() => { void reload(); return () => request.current?.abort(); }, [reload]);
  return { ...(state.key === key ? state : empty(key)), reload, loadMore };
}
