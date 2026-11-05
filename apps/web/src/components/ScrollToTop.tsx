'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';

/**
 * A floating "scroll to top" button that appears when the user has
 * scrolled down. Smoothly scrolls to the top of the page.
 */
export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = () => {
      setVisible(window.scrollY > 400);
    };
    window.addEventListener('scroll', handler, { passive: true });
    handler();
    return () => window.removeEventListener('scroll', handler);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      className={`scroll-to-top${visible ? ' visible' : ''}`}
      aria-label="Scroll to top"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }}
    >
      <Icon name="arrow-left" size={20} style={{ transform: 'rotate(90deg)' }} />
    </button>
  );
}
