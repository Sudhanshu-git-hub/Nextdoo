'use client';
import { useWorkspace } from './WorkspaceContext';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Navigation mirrors the core loop, not a feature catalogue (PRD §8.1). */
const LINKS = [
  { href: '/today', label: 'Today', icon: '◎' },
  { href: '/inbox', label: 'Inbox', icon: '▤' },
  { href: '/projects', label: 'Projects', icon: '❏' },
  { href: '/calendar', label: 'Calendar', icon: '▦' },
  { href: '/notifications', label: 'Notifications', icon: '♧' },
  { href: '/focus', label: 'Focus', icon: '◐' },
  { href: '/analytics', label: 'Analytics', icon: '◲' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export function Sidebar() {
  const workspace = useWorkspace();
  const pathname = usePathname();
  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="brand">NEXT<span>DOO</span></div>
      <p className="muted" style={{ overflowWrap: 'anywhere' }}>{workspace.name}</p>
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="nav-link"
          aria-current={pathname === link.href ? 'page' : undefined}
        >
          <span className="nav-icon" aria-hidden="true">{link.icon}</span>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
