'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';

export interface Breadcrumb {
  label: string;
  href?: string;
}

/**
 * Breadcrumb navigation bar for detail pages.
 * Renders a horizontal chain of links showing the path from the
 * parent list to the current item, plus a "back" affordance.
 */
export function Breadcrumb({ items }: { items: Breadcrumb[] }) {
  const router = useRouter();

  if (items.length === 0) return null;

  // First item is always the root — no link needed if it matches current path
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb-nav">
      <ol className="breadcrumb-list">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          const isActive = isLast;
          return (
            <li key={`${item.label}-${index}`} className="breadcrumb-item">
              {isLast || !item.href ? (
                <span aria-current="page" className="breadcrumb-link breadcrumb-current">
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  className="breadcrumb-link"
                  // Pass through for nested routes
                  aria-current={isActive ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              )}
              {!isLast && <span className="breadcrumb-sep" aria-hidden="true">›</span>}
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="breadcrumb-back"
        onClick={() => {
          if (window.history.length > 1) router.back();
          else router.push('/');
        }}
      >
        ← Back
      </button>
    </nav>
  );
}
