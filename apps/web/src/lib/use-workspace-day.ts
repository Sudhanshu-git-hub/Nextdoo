'use client';
import { useEffect, useState } from 'react';
import { localDateKey } from '@nextdoo/core/calendar';
export function useWorkspaceDay(zone: string) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const refresh = () => setNow(new Date());
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  return { now, day: localDateKey(now, zone) };
}
