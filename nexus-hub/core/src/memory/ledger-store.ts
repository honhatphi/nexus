// ─────────────────────────────────────────────────────────────
// LedgerStore — in-memory implementation for testing.
// FileSystemLedgerStore handles production persistence.
// ─────────────────────────────────────────────────────────────

import type { TaskLedger } from "../contracts/task-ledger.js";
import type { MemoryStore } from "../ports/memory-store.js";

export class InMemoryLedgerStore implements MemoryStore {
  private readonly store = new Map<string, TaskLedger>();

  async openTask(taskId: string, objective: string): Promise<TaskLedger> {
    const now = new Date().toISOString();
    const ledger: TaskLedger = {
      taskId,
      objective,
      currentState: "Task opened. No actions taken yet.",
      constraints: [],
      decisions: [],
      touchedFiles: [],
      commandsRun: [],
      openQuestions: [],
      nextActions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(taskId, ledger);
    return ledger;
  }

  async getTask(taskId: string): Promise<TaskLedger | null> {
    return this.store.get(taskId) ?? null;
  }

  async updateTask(
    taskId: string,
    patch: Partial<TaskLedger>,
  ): Promise<TaskLedger> {
    const existing = this.store.get(taskId);
    if (!existing) {
      throw new Error(`Task "${taskId}" not found`);
    }
    const updated: TaskLedger = {
      ...existing,
      ...patch,
      taskId: existing.taskId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(taskId, updated);
    return updated;
  }

  async closeTask(taskId: string): Promise<void> {
    this.store.delete(taskId);
  }
}
