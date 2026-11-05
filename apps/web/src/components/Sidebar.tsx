'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useCallback } from 'react';
import Link from 'next/link';

/** The primary navigation surface, shared by desktop and mobile. */
function navItems(): { href: string; label: string; icon: string; group: string }[] {
  return [
    { href: '/', label: 'Home', icon: '⌂', group: 'Start' },
    { href: '/inbox', label: 'Inbox', icon: '▣', group: 'Start' },
    { href: '/today', label: 'Today', icon: '◎', group: 'Start' },
    { href: '/tomorrow', label: 'Tomorrow', icon: '◴', group: 'Start' },
    { href: '/upcoming', label: 'Upcoming', icon: '▦', group: 'Start' },
    { href: '/tasks', label: 'Tasks', icon: '☑', group: 'Plan' },
    { href: '/task-history', label: 'Task History', icon: '⟳', group: 'Plan' },
    { href: '/focus', label: 'Focus', icon: '◐', group: 'Plan' },
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
    { href: '/settings', label: 'Settings', icon: '⚙', group: 'System' },
  ];
}

/** Returns true if the given href is an ancestor or self of the current pathname. */
function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

/** A short vertically stacked nav; mobile callers can render it inside a select. */
export function MobileNavigation({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const items = navItems();
  const currentIndex = items.findIndex((item) => pathname === item.href);
  return (
    <select
      aria-label="Navigate"
      className="mobile-select"
      defaultValue={currentIndex >= 0 ? currentIndex + 1 : ''}
      onChange={(event) => {
        const href = event.target.selectedOptions[0]?.value;
        if (href) router.push(href);
      }}
    >
      <option value="" disabled>
        {compact ? 'Workspace pages' : 'NEXTDOO navigation'}
      </option>
      {items.map((item, index) => (
        <option key={item.href} value={index + 1}>
          {item.icon} {item.label}
        </option>
      ))}
    </select>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const items = navItems();
  const isActive = useCallback(
    (href: string) => isActivePath(pathname, href),
    [pathname],
  );

  // Build the list of top-level links for keyboard navigation.
  const navLinks = items.map((item) => ({
    ...item,
    isActive: isActive(item.href),
  }));

  const onKeydown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
      const links = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[tabindex]'));
      event.preventDefault();
      const current = links.findIndex((el) => el.getAttribute('tabindex') === '0');
      const next =
        event.key === 'ArrowDown'
          ? links[(current + 1) % links.length]
          : event.key === 'ArrowUp'
            ? links[(current - 1 + links.length) % links.length]
            : event.key === 'End'
              ? links[links.length - 1]
              : links[0];
      event.currentTarget.setAttribute('tabindex', '-1');
      next?.focus();
    },
    [],
  );

  // Start at the first item when tabbing in and loop back to the end.
  const itemsWithIndex = navLinks.map((item, index) => ({ ...item, tabindex: (index === 0 ? 0 : undefined) as number | undefined }));

  return (
    <nav aria-label="Primary navigation" onKeyDown={onKeydown}>
      <Link href="#main" className="skip-link" style={{ position: 'static', width: 'auto', height: 'auto', margin: 0, clip: 'auto', overflow: 'visible', color: 'inherit' }}>
        Skip to content
      </Link>
      <div className="brand">
        <span className="brand-mark">N</span>
        NEXT<span>DOO</span>
      </div>
      {(['Start', 'Plan', 'Find', 'Insights', 'System'] as const).map((group) => (
        <div key={group}>
          <div className="nav-group-label">{group}</div>
          {itemsWithIndex
            .filter((item) => item.group === group)
            .map((item) => (
              <a
                key={item.href}
                href={item.href}
                aria-current={item.isActive ? 'page' : undefined}
                title={item.label}
                tabIndex={item.tabindex}
                className="nav-link"
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </a>
            ))}
        </div>
      ))}
      <div className="muted" style={{ marginTop: 'auto', padding: '12px 10px 0', fontSize: '12px' }}>
        Task planning, trusted.
      </div>
    </nav>
  );
}
