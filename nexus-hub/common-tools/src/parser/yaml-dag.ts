// ─────────────────────────────────────────────────────────────
// YAML DAG Parser — Airflow dag-factory YAML file parser
// ─────────────────────────────────────────────────────────────

import yaml from "js-yaml";
import type { ParseResult, DagInfo, DagTaskInfo } from "../types.js";

/**
 * Parse a YAML file for Airflow DAG definitions (dag-factory convention).
 * Each top-level key is a DAG name.
 */
export function parseYamlDag(filePath: string, source: string): ParseResult {
  const parseErrors: string[] = [];
  const dags: DagInfo[] = [];

  let doc: unknown;
  try {
    doc = yaml.load(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parseErrors.push(`YAML parse error: ${msg}`);
    return {
      file: filePath,
      language: "yaml",
      symbols: [],
      functions: [],
      classes: [],
      infraPatterns: [],
      dags: [],
      parseErrors,
    };
  }

  if (!doc || typeof doc !== "object") {
    return {
      file: filePath,
      language: "yaml",
      symbols: [],
      functions: [],
      classes: [],
      infraPatterns: [],
      dags: [],
      parseErrors: ["YAML file has no top-level object."],
    };
  }

  for (const [dagName, dagDef] of Object.entries(
    doc as Record<string, unknown>,
  )) {
    if (!dagDef || typeof dagDef !== "object") continue;

    const dagObj = dagDef as Record<string, unknown>;
    const defaultArgs = (dagObj.default_args ?? {}) as Record<string, unknown>;
    const tasksObj = dagObj.tasks as Record<string, unknown> | undefined;

    const dagInfo: DagInfo = {
      name: dagName,
      scheduleInterval: asString(dagObj.schedule_interval),
      description: asString(dagObj.description),
      owner: asString(defaultArgs.owner),
      concurrency:
        typeof dagObj.concurrency === "number" ? dagObj.concurrency : null,
      tasks: [],
    };

    if (tasksObj && typeof tasksObj === "object") {
      for (const [taskName, taskDef] of Object.entries(tasksObj)) {
        if (!taskDef || typeof taskDef !== "object") continue;
        const t = taskDef as Record<string, unknown>;

        const task: DagTaskInfo = {
          name: taskName,
          operator: asString(t.operator) ?? "unknown",
          pythonCallableFile: asString(t.python_callable_file),
          pythonCallableName: asString(t.python_callable_name),
          bashCommand: asString(t.bash_command),
          sql: asString(t.sql),
          postgresConnId: asString(t.postgres_conn_id),
          dependencies: asStringArray(t.dependencies),
          opKwargs:
            t.op_kwargs && typeof t.op_kwargs === "object"
              ? (t.op_kwargs as Record<string, unknown>)
              : null,
          retries: typeof t.retries === "number" ? t.retries : null,
          executionTimeoutSecs:
            typeof t.execution_timeout_secs === "number"
              ? t.execution_timeout_secs
              : null,
        };

        dagInfo.tasks.push(task);
      }
    }

    dags.push(dagInfo);
  }

  return {
    file: filePath,
    language: "yaml",
    symbols: [],
    functions: [],
    classes: [],
    infraPatterns: [],
    dags,
    parseErrors,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function asString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return String(val);
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v) => v != null).map(String);
}
