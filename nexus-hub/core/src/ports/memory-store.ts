// ─────────────────────────────────────────────────────────────
// Port: MemoryStore — task ledger persistence abstraction.
// Fully implemented in PR 4 — Task Ledger.
// ─────────────────────────────────────────────────────────────

import type { TaskLedger } from "../contracts/task-ledger.js";

export interface MemoryStore {
  openTask(taskId: string, objective: string): Promise<TaskLedger>;
  getTask(taskId: string): Promise<TaskLedger | null>;
  updateTask(taskId: string, patch: Partial<TaskLedger>): Promise<TaskLedger>;
  closeTask(taskId: string): Promise<void>;
}
