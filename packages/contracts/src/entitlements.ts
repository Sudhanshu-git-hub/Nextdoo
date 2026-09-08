import type { Plan } from './enums';

/**
 * PRD §18.1 — server-side entitlement limits.
 * Never trust a client-supplied plan; these are resolved from verified billing state.
 * `null` means unlimited.
 */
export interface EntitlementLimits {
  activeTasks: number | null;
  projects: number | null;
  attachmentStorageBytes: number;
  maxFileBytes: number;
  calendarConnections: number;
  trackingHistoryDays: number | null;
  aiRequestsPerMonth: number;
  exportsPerDay: number | null;
  seats: number;
  auditLogRetentionDays: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const ENTITLEMENTS: Record<Plan, EntitlementLimits> = {
  FREE: {
    activeTasks: 200,
    projects: 3,
    attachmentStorageBytes: 100 * MB,
    maxFileBytes: 10 * MB,
    calendarConnections: 1,
    trackingHistoryDays: 30,
    aiRequestsPerMonth: 20,
    exportsPerDay: 1,
    seats: 1,
    auditLogRetentionDays: 0,
  },
  PRO: {
    activeTasks: null,
    projects: null,
    attachmentStorageBytes: 5 * GB,
    maxFileBytes: 100 * MB,
    calendarConnections: 3,
    trackingHistoryDays: null,
    aiRequestsPerMonth: 500,
    exportsPerDay: null,
    seats: 1,
    auditLogRetentionDays: 30,
  },
  TEAM: {
    activeTasks: null,
    projects: null,
    attachmentStorageBytes: 10 * GB,
    maxFileBytes: 250 * MB,
    calendarConnections: 5,
    trackingHistoryDays: null,
    aiRequestsPerMonth: 1000,
    exportsPerDay: null,
    seats: 50,
    auditLogRetentionDays: 365,
  },
  ENTERPRISE: {
    activeTasks: null,
    projects: null,
    attachmentStorageBytes: 100 * GB,
    maxFileBytes: 1024 * MB,
    calendarConnections: 100,
    trackingHistoryDays: null,
    aiRequestsPerMonth: 100_000,
    exportsPerDay: null,
    seats: 10_000,
    auditLogRetentionDays: 2555,
  },
};

export function limitsFor(plan: Plan): EntitlementLimits {
  return ENTITLEMENTS[plan];
}
