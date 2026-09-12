'use client';
export function TaskPagination({ hasMore, loading, error, count, onMore, onRetry }: {
  hasMore: boolean; loading: boolean; error: string | null; count: number; onMore: () => void; onRetry: () => void;
}) {
  return <div style={{ marginTop: 16 }}>
    <p className="muted" role="status">{count} tasks loaded{hasMore ? ' — more available' : ''}.</p>
    {error && <div role="alert" className="banner banner-error">{error} <button onClick={onRetry}>Retry task loading</button></div>}
    {hasMore && <button disabled={loading} onClick={onMore}>{loading ? 'Loading more…' : 'Load more tasks'}</button>}
  </div>;
}
