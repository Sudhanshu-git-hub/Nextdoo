'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Primary navigation items shown in the mobile bottom bar. */
const PRIMARY_ITEMS = [
  { href: '/', label: 'Home', icon: '⌂' },
  { href: '/inbox', label: 'Inbox', icon: '▣' },
  { href: '/today', label: 'Today', icon: '◎' },
  { href: '/focus', label: 'Focus', icon: '◐' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
] as const;

/** Secondary items revealed in the hamburger drawer. */
const SECONDARY_ITEMS = [
  { href: '/tomorrow', label: 'Tomorrow', icon: '◴', group: 'Plan' },
  { href: '/upcoming', label: 'Upcoming', icon: '▦', group: 'Plan' },
  { href: '/tasks', label: 'Tasks', icon: '☑', group: 'Plan' },
  { href: '/task-history', label: 'Task History', icon: '⟳', group: 'Plan' },
  { href: '/overdue', label: 'Overdue', icon: '!', group: 'Plan' },
  { href: '/backlog', label: 'Backlog', icon: '✓', group: 'Plan' },
  { href: '/completed', label: 'Completed', icon: '⌖', group: 'Plan' },
  { href: '/goals', label: 'Goals', icon: '◇', group: 'Plan' },
  { href: '/trackers', label: 'Trackers', icon: '◷', group: 'Plan' },
  { href: '/knowledge', label: 'Knowledge', icon: '❏', group: 'Plan' },
  { href: '/projects', label: 'Projects', icon: '▥', group: 'Plan' },
  { href: '/calendar', label: 'Calendar', icon: '◲', group: 'Plan' },
  { href: '/recurrences', label: 'Recurrences', icon: '↻', group: 'Plan' },
  { href: '/search', label: 'Search', icon: '⌕', group: 'Find' },
  { href: '/insights', label: 'Insights', icon: '♧', group: 'Insights' },
  { href: '/analytics', label: 'Analytics', icon: '↗', group: 'Insights' },
  { href: '/notifications', label: 'Notifications', icon: '◔', group: 'System' },
  { href: '/conflicts', label: 'Sync Conflicts', icon: '⇄', group: 'System' },
] as const;

export function MobileNavBar() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // Close drawer on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Close drawer on Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [drawerOpen]);

  // Lock body scroll when drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [drawerOpen]);

  const isActive = useCallback(
    (href: string) => {
      if (href === '/') return pathname === '/';
      return pathname === href || pathname.startsWith(href + '/');
    },
    [pathname],
  );

  return (
    <>
      {/* Bottom navigation bar — fixed, above PWA install banner */}
      <nav className="mobile-nav-bar" aria-label="Mobile navigation">
        {PRIMARY_ITEMS.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={`mobile-nav-item${isActive(item.href) ? ' active' : ''}`}
            aria-current={isActive(item.href) ? 'page' : undefined}
          >
            <span className="mobile-nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="mobile-nav-label">{item.label}</span>
          </a>
        ))}
        <button
          className={`mobile-nav-item mobile-nav-drawer${drawerOpen ? ' active' : ''}`}
          aria-label="More pages"
          aria-expanded={drawerOpen}
          aria-controls="mobile-drawer"
          onClick={() => setDrawerOpen((v) => !v)}
        >
          <span className="mobile-nav-icon" aria-hidden="true">≡</span>
          <span className="mobile-nav-label">More</span>
        </button>
      </nav>

      {/* Hamburger drawer for secondary pages */}
      {drawerOpen && (
        <div
          id="mobile-drawer"
          className="mobile-drawer-overlay"
          onClick={() => setDrawerOpen(false)}
          role="presentation"
        >
          <div
            className="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="More pages"
            ref={drawerRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobile-drawer-header">
              <span className="mobile-drawer-title">Pages</span>
              <button
                className="mobile-drawer-close"
                aria-label="Close menu"
                onClick={() => setDrawerOpen(false)}
              >
                ✕
              </button>
            </div>
            {(['Plan', 'Find', 'Insights', 'System'] as const).map((group) => (
              <div key={group} className="mobile-drawer-group">
                <div className="mobile-drawer-group-label">{group}</div>
                {SECONDARY_ITEMS.filter((item) => item.group === group).map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className={`mobile-drawer-link${isActive(item.href) ? ' active' : ''}`}
                    aria-current={isActive(item.href) ? 'page' : undefined}
                  >
                    <span className="mobile-nav-icon" aria-hidden="true">{item.icon}</span>
                    <span>{item.label}</span>
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
