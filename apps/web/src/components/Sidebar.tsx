'use client';
import { useWorkspace } from './WorkspaceContext';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

/** Navigation mirrors the core loop, not a feature catalogue (PRD §8.1). */
const LINKS = [
  { href: '/home', label: 'Home', icon: '⌂' },
  { href: '/inbox', label: 'Inbox', icon: '▤' },
  { href: '/today', label: 'Today', icon: '◎' },
  { href: '/tomorrow', label: 'Tomorrow', icon: '◴' },
  { href: '/upcoming', label: 'Upcoming', icon: '▦' },
  { href: '/focus', label: 'Focus', icon: '◐' },
  { href: '/overdue', label: 'Overdue', icon: '!' },
  { href: '/backlog', label: 'Backlog', icon: '▤' },
  { href: '/completed', label: 'Completed', icon: '✓' },
  { href: '/search', label: 'Search', icon: '⌕' },
  { href: '/goals', label: 'Goals', icon: '◇' },
  { href: '/trackers', label: 'Tracker', icon: '◷' },
  { href: '/knowledge', label: 'Knowledge & Data', icon: '▥' },
  { href: '/projects', label: 'Projects', icon: '❏' },
  { href: '/calendar', label: 'Calendar', icon: '▦' },
  { href: '/insights', label: 'Insights', icon: '▥' },
  { href: '/analytics', label: 'Analytics', icon: '◲' },
  { href: '/notifications', label: 'Notifications', icon: '♧' },
  { href: '/conflicts', label: 'Sync conflicts', icon: '⇄' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export function Sidebar() {
  const workspace = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  return (
    <><nav className="sidebar" aria-label="Main navigation">
      <div className="brand">NEXT<span>DOO</span></div>
      <p className="muted" style={{ overflowWrap: 'anywhere' }}>{workspace.name}</p>
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="nav-link"
          aria-label={link.label}
          title={link.label}
          aria-current={pathname === link.href ? 'page' : undefined}
        >
          <span className="nav-icon" aria-hidden="true">{link.icon}</span>
          <span className="nav-label">{link.label}</span>
        </Link>
      ))}
    </nav><nav className="mobile-navigation" aria-label="Mobile navigation"><label>Go to<select aria-label="Go to" value={LINKS.some(link => link.href === pathname) ? pathname : ''} onChange={event => { if (event.target.value) router.push(event.target.value); }}><option value="">Choose a destination</option>{LINKS.map(link => <option key={link.href} value={link.href}>{link.label}</option>)}</select></label></nav></>
  );
}
