// ─────────────────────────────────────────────────────────────
// MCP tools: Task Ledger (PR 4)
// nexus_open_task, nexus_get_task_state, nexus_update_ledger,
// nexus_close_task
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LedgerService } from "@nexus-hub/core";

export function registerLedgerTools(
  server: McpServer,
  ledger: LedgerService,
): void {
  // ── nexus_open_task ────────────────────────────────────────
  server.tool(
    "nexus_open_task",
    "Open a new task ledger to track a coding or debugging session. Returns a taskId to reference in subsequent tool calls. The ledger replaces chat-history replay with structured, compact task state.",
    {
      objective: z
        .string()
        .describe("Brief description of what needs to be accomplished."),
      task_id: z
        .string()
        .optional()
        .describe(
          "Optional explicit task ID. Auto-generated if omitted (e.g. task_a1b2c3d4).",
        ),
    },
    async ({ objective, task_id }) => {
      try {
        const result = await ledger.openTask(objective, task_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── nexus_get_task_state ───────────────────────────────────
  server.tool(
    "nexus_get_task_state",
    "Retrieve the current compact state of an open task ledger. Returns objective, currentState, constraints, touched files, open questions, and next actions without replaying full chat history.",
    {
      task_id: z.string().describe("The task ID returned by nexus_open_task."),
    },
    async ({ task_id }) => {
      try {
        const state = await ledger.getTaskState(task_id);
        if (!state) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Task "${task_id}" not found.`,
                  suggestion: "Call nexus_open_task to start a new task.",
                }),
              },
            ],
          };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(state, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── nexus_update_ledger ────────────────────────────────────
  server.tool(
    "nexus_update_ledger",
    "Update the task ledger after a meaningful step. Record the new state, decisions made, files touched, commands run, open questions resolved or added, and next actions. Call this after each significant change.",
    {
      task_id: z.string().describe("Task ID to update."),
      current_state: z
        .string()
        .optional()
        .describe("Updated description of current progress."),
      add_constraints: z
        .array(z.string())
        .optional()
        .describe("New constraints to add (deduplicated)."),
      add_decisions: z
        .array(
          z.object({
            description: z.string(),
            rationale: z.string().optional(),
          }),
        )
        .optional()
        .describe("Decisions made during this step."),
      add_touched_files: z
        .array(z.string())
        .optional()
        .describe("Files created or modified (deduplicated)."),
      add_open_questions: z
        .array(z.string())
        .optional()
        .describe("New questions that came up."),
      set_next_actions: z
        .array(z.string())
        .optional()
        .describe("Replace the next actions list entirely."),
    },
    async ({
      task_id,
      current_state,
      add_constraints,
      add_decisions,
      add_touched_files,
      add_open_questions,
      set_next_actions,
    }) => {
      try {
        const now = new Date().toISOString();
        const state = await ledger.updateLedger({
          taskId: task_id,
          currentState: current_state,
          addConstraints: add_constraints,
          addDecisions: add_decisions?.map((d) => ({
            ...d,
            at: now,
          })),
          addTouchedFiles: add_touched_files,
          addOpenQuestions: add_open_questions,
          setNextActions: set_next_actions,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(state, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── nexus_close_task ───────────────────────────────────────
  server.tool(
    "nexus_close_task",
    "Close and remove the task ledger when the task is complete. Call this after verifying all acceptance criteria are met.",
    {
      task_id: z.string().describe("Task ID to close."),
    },
    async ({ task_id }) => {
      try {
        await ledger.closeTask(task_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ closed: true, taskId: task_id }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
