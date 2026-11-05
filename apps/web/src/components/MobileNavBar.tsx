'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '@/components/Icon';

/** Primary navigation items shown in the mobile bottom bar. */
const PRIMARY_ITEMS = [
  { href: '/', label: 'Home', icon: 'home' as IconName },
  { href: '/inbox', label: 'Inbox', icon: 'inbox' as IconName },
  { href: '/today', label: 'Today', icon: 'today' as IconName },
  { href: '/focus', label: 'Focus', icon: 'focus' as IconName },
  { href: '/settings', label: 'Settings', icon: 'settings' as IconName },
] as const;

/** Secondary items revealed in the hamburger drawer. */
const SECONDARY_ITEMS = [
  { href: '/tomorrow', label: 'Tomorrow', icon: 'tomorrow' as IconName, group: 'Plan' },
  { href: '/upcoming', label: 'Upcoming', icon: 'upcoming' as IconName, group: 'Plan' },
  { href: '/tasks', label: 'Tasks', icon: 'tasks' as IconName, group: 'Plan' },
  { href: '/task-history', label: 'Task History', icon: 'task-history' as IconName, group: 'Plan' },
  { href: '/overdue', label: 'Overdue', icon: 'overdue' as IconName, group: 'Plan' },
  { href: '/backlog', label: 'Backlog', icon: 'backlog' as IconName, group: 'Plan' },
  { href: '/completed', label: 'Completed', icon: 'completed' as IconName, group: 'Plan' },
  { href: '/goals', label: 'Goals', icon: 'goals' as IconName, group: 'Plan' },
  { href: '/trackers', label: 'Trackers', icon: 'trackers' as IconName, group: 'Plan' },
  { href: '/knowledge', label: 'Knowledge', icon: 'knowledge' as IconName, group: 'Plan' },
  { href: '/projects', label: 'Projects', icon: 'projects' as IconName, group: 'Plan' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar' as IconName, group: 'Plan' },
  { href: '/recurrences', label: 'Recurrences', icon: 'recurrences' as IconName, group: 'Plan' },
  { href: '/search', label: 'Search', icon: 'search' as IconName, group: 'Find' },
  { href: '/insights', label: 'Insights', icon: 'insights' as IconName, group: 'Insights' },
  { href: '/analytics', label: 'Analytics', icon: 'analytics' as IconName, group: 'Insights' },
  { href: '/notifications', label: 'Notifications', icon: 'notifications' as IconName, group: 'System' },
  { href: '/conflicts', label: 'Sync Conflicts', icon: 'sync' as IconName, group: 'System' },
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
            <span className="mobile-nav-icon"><Icon name={item.icon} size={22} /></span>
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
          <span className="mobile-nav-icon"><Icon name="menu" size={22} /></span>
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
                <Icon name="x" size={20} />
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
                    <span className="mobile-nav-icon"><Icon name={item.icon} size={18} /></span>
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
