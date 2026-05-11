// ─────────────────────────────────────────────────────────────
// Contract: TaskLedger — structured task state replacing
// chat-history replay. Persisted locally under ~/.nexus/.
// ─────────────────────────────────────────────────────────────

export interface Decision {
  at: string;
  description: string;
  rationale?: string;
}

export interface CommandSummary {
  cmd: string;
  exitCode: number;
  durationMs: number;
  at: string;
}

export interface TaskLedger {
  taskId: string;
  objective: string;
  currentState: string;
  constraints: string[];
  decisions: Decision[];
  touchedFiles: string[];
  commandsRun: CommandSummary[];
  openQuestions: string[];
  nextActions: string[];
  createdAt: string;
  updatedAt: string;
}
