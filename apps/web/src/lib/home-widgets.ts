import type { Personalization } from '@nextdoo/contracts';
export type HomeWidget = Personalization['homeCards'][number];
export const HOME_WIDGETS: Record<HomeWidget, { title: string; href: string; description: string }> = {
  today: { title: 'My Tasks / Today', href: '/today', description: 'Incomplete tasks due today' },
  upcoming: { title: 'Upcoming', href: '/upcoming', description: 'The next seven days, starting tomorrow' },
  overdue: { title: 'Overdue', href: '/overdue', description: 'Incomplete tasks due before today' },
  priorities: { title: 'Priorities', href: '/tasks?priority=HIGH', description: 'High-priority active tasks' },
  goals: { title: 'Goals', href: '/goals', description: 'Your goals and measured progress' },
  focus: { title: 'Focus', href: '/focus', description: 'Continue your current session' },
  calendar: { title: 'Calendar', href: '/calendar', description: 'Visible events today' },
  tracker: { title: 'Tracker', href: '/trackers', description: 'Your trackers today' },
  knowledge: { title: 'Recent Knowledge', href: '/knowledge', description: 'Recently updated notes and records' },
  notes: { title: 'Quick Notes', href: '/knowledge', description: 'Save a real note in Knowledge & Data' },
  insights: { title: 'Productivity summary', href: '/insights?period=day', description: 'Today’s measured activity' },
};
export interface HomeCardData { items: Array<{ id: string; title: string; href: string; detail: string }>; more: boolean; }
