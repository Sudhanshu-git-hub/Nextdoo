'use client';
import { createContext, useContext } from 'react';
import type { WorkspaceSettings } from '@nextdoo/contracts';
export type WorkspaceSnapshot = WorkspaceSettings & { id: string; version: number };
const Context = createContext<WorkspaceSnapshot | null>(null);
export function WorkspaceProvider({ value, children }: { value: WorkspaceSnapshot; children: React.ReactNode }) { return <Context.Provider value={value}>{children}</Context.Provider>; }
export function useWorkspace() { const value = useContext(Context); if (!value) throw new Error('Workspace context is required'); return value; }
