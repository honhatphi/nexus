// ─────────────────────────────────────────────────────────────
// LedgerService — business logic layer over MemoryStore.
// Exposes compact task state for MCP tool handlers.
// ─────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import type {
  TaskLedger,
  Decision,
  CommandSummary,
} from "../contracts/task-ledger.js";
import type { MemoryStore } from "../ports/memory-store.js";

export interface OpenTaskResult {
  taskId: string;
  objective: string;
  createdAt: string;
}

export interface CompactTaskState {
  taskId: string;
  objective: string;
  currentState: string;
  constraints: string[];
  touchedFiles: string[];
  openQuestions: string[];
  nextActions: string[];
  decidedCount: number;
  commandsRun: number;
  updatedAt: string;
}

export interface UpdateLedgerInput {
  taskId: string;
  currentState?: string;
  addConstraints?: string[];
  addDecisions?: Decision[];
  addTouchedFiles?: string[];
  addCommandsRun?: CommandSummary[];
  addOpenQuestions?: string[];
  setNextActions?: string[];
}

export class LedgerService {
  constructor(private readonly store: MemoryStore) {}

  async openTask(objective: string, taskId?: string): Promise<OpenTaskResult> {
    const id = taskId ?? `task_${randomUUID().slice(0, 8)}`;
    const ledger = await this.store.openTask(id, objective);
    return {
      taskId: ledger.taskId,
      objective: ledger.objective,
      createdAt: ledger.createdAt,
    };
  }

  async getTaskState(taskId: string): Promise<CompactTaskState | null> {
    const ledger = await this.store.getTask(taskId);
    if (!ledger) return null;
    return this.toCompact(ledger);
  }

  async updateLedger(input: UpdateLedgerInput): Promise<CompactTaskState> {
    const existing = await this.store.getTask(input.taskId);
    if (!existing) {
      throw new Error(
        `Task "${input.taskId}" not found. Call nexus_open_task first.`,
      );
    }

    const patch: Partial<TaskLedger> = {};

    if (input.currentState !== undefined) {
      patch.currentState = input.currentState;
    }
    if (input.addConstraints?.length) {
      patch.constraints = [
        ...new Set([...existing.constraints, ...input.addConstraints]),
      ];
    }
    if (input.addDecisions?.length) {
      patch.decisions = [...existing.decisions, ...input.addDecisions];
    }
    if (input.addTouchedFiles?.length) {
      patch.touchedFiles = [
        ...new Set([...existing.touchedFiles, ...input.addTouchedFiles]),
      ];
    }
    if (input.addCommandsRun?.length) {
      patch.commandsRun = [...existing.commandsRun, ...input.addCommandsRun];
    }
    if (input.addOpenQuestions?.length) {
      patch.openQuestions = [
        ...new Set([...existing.openQuestions, ...input.addOpenQuestions]),
      ];
    }
    if (input.setNextActions !== undefined) {
      patch.nextActions = input.setNextActions;
    }

    const updated = await this.store.updateTask(input.taskId, patch);
    return this.toCompact(updated);
  }

  async closeTask(taskId: string): Promise<void> {
    return this.store.closeTask(taskId);
  }

  private toCompact(ledger: TaskLedger): CompactTaskState {
    return {
      taskId: ledger.taskId,
      objective: ledger.objective,
      currentState: ledger.currentState,
      constraints: ledger.constraints,
      touchedFiles: ledger.touchedFiles,
      openQuestions: ledger.openQuestions,
      nextActions: ledger.nextActions,
      decidedCount: ledger.decisions.length,
      commandsRun: ledger.commandsRun.length,
      updatedAt: ledger.updatedAt,
    };
  }
}
