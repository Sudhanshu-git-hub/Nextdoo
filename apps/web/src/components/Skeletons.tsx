'use client';

/**
 * Phase 4: Reusable skeleton screen components.
 *
 * Each skeleton renders a shimmering placeholder that matches the shape
 * of the content it replaces, so the layout doesn't jump when data arrives.
 * All use the existing `.skeleton` CSS class and `shimmer` animation.
 */

/** A single shimmering text line. `width` accepts CSS width values. */
export function SkeletonText({ width = '100%', height = 16, style }: { width?: string; height?: number; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ width, height, ...style }} aria-hidden="true" />;
}

/** A card-shaped skeleton with a title bar and body lines. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card" aria-hidden="true" style={{ overflow: 'hidden' }}>
      <SkeletonText width="60%" height={20} style={{ marginBottom: 12 }} />
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonText
          key={i}
          width={i === lines - 1 ? '40%' : '100%'}
          height={14}
          style={{ marginBottom: 8 }}
        />
      ))}
    </div>
  );
}

/** A stat/KPI card skeleton. */
export function SkeletonStat() {
  return (
    <div className="card home-stats-skeleton" aria-hidden="true">
      <SkeletonText width="50%" height={28} style={{ marginBottom: 6 }} />
      <SkeletonText width="70%" height={12} />
    </div>
  );
}

/** A task row skeleton matching the TaskList row shape. */
export function SkeletonTaskRow({ height = 56 }: { height?: number }) {
  return (
    <div className="skeleton" style={{ height, borderRadius: 'var(--radius)', marginBottom: 8 }} aria-hidden="true" />
  );
}

/** A list of skeleton task rows. */
export function SkeletonTaskList({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading tasks">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonTaskRow key={i} />
      ))}
    </div>
  );
}

/** A calendar day skeleton. */
export function SkeletonCalendarDay({ view = 'day' }: { view?: 'day' | 'week' | 'month' }) {
  const height = view === 'month' ? 22 : view === 'week' ? 30 : 80;
  return <div className="skeleton" style={{ height, borderRadius: 'var(--radius-sm)' }} aria-hidden="true" />;
}

/** A full analytics dashboard skeleton (KPIs + chart area). */
export function SkeletonAnalytics() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading analytics">
      <div className="home-stats" style={{ marginBottom: 20 }}>
        {Array.from({ length: 4 }, (_, i) => <SkeletonStat key={i} />)}
      </div>
      <div className="card" style={{ padding: 20 }}>
        <SkeletonText width="40%" height={20} style={{ marginBottom: 16 }} />
        <SkeletonText width="100%" height={200} />
      </div>
    </div>
  );
}

/** A generic list skeleton with N rows. */
export function SkeletonList({ rows = 5, height = 44, gap = 8 }: { rows?: number; height?: number; gap?: number }) {
  return (
    <div role="status" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="skeleton"
          style={{ height, borderRadius: 'var(--radius-sm)', marginBottom: gap }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

/** A section/panel skeleton for settings and detail views. */
export function SkeletonSection({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card" aria-hidden="true" style={{ overflow: 'hidden' }}>
      <SkeletonText width="50%" height={20} style={{ marginBottom: 16 }} />
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonText
          key={i}
          width={i === rows - 1 ? '60%' : '100%'}
          height={16}
          style={{ marginBottom: 12 }}
        />
      ))}
    </div>
  );
}
