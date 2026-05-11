// ─────────────────────────────────────────────────────────────
// FileSystemLedgerStore — persists TaskLedgers as JSON files
// under ~/.nexus/workspaces/<workspaceId>/ledgers/<taskId>.json
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import type { TaskLedger } from "../contracts/task-ledger.js";
import type { MemoryStore } from "../ports/memory-store.js";
import { nexusWorkspaceDir } from "../env.js";

export class FileLedgerStore implements MemoryStore {
  private readonly baseDir: string;

  constructor(workspaceId: string) {
    this.baseDir = path.join(nexusWorkspaceDir(workspaceId), "ledgers");
  }

  private ledgerPath(taskId: string): string {
    return path.join(this.baseDir, `${taskId}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  async openTask(taskId: string, objective: string): Promise<TaskLedger> {
    await this.ensureDir();
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
    await fs.writeFile(
      this.ledgerPath(taskId),
      JSON.stringify(ledger, null, 2),
    );
    return ledger;
  }

  async getTask(taskId: string): Promise<TaskLedger | null> {
    try {
      const raw = await fs.readFile(this.ledgerPath(taskId), "utf-8");
      return JSON.parse(raw) as TaskLedger;
    } catch {
      return null;
    }
  }

  async updateTask(
    taskId: string,
    patch: Partial<TaskLedger>,
  ): Promise<TaskLedger> {
    const existing = await this.getTask(taskId);
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
    await this.ensureDir();
    await fs.writeFile(
      this.ledgerPath(taskId),
      JSON.stringify(updated, null, 2),
    );
    return updated;
  }

  async closeTask(taskId: string): Promise<void> {
    try {
      await fs.unlink(this.ledgerPath(taskId));
    } catch {
      // already gone — no-op
    }
  }
}
