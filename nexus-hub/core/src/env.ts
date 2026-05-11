// ─────────────────────────────────────────────────────────────
// env.ts — centralised environment-variable reader for core.
//
// All modules inside nexus-hub/core MUST import runtime
// defaults from here instead of using os.homedir() or
// process.env directly.  This makes every path/value
// configurable without touching source code.
//
// Supported variables (with defaults):
//
//   NEXUS_DATA_DIR                   ~/.nexus
//   NEXUS_WORKSPACE_ID               default
//   NEXUS_DEFAULT_MAX_INPUT_TOKENS   12000
//   NEXUS_DEFAULT_RESERVED_TOKENS    3000
// ─────────────────────────────────────────────────────────────

import os from "node:os";
import path from "node:path";

/** Base directory for all Nexus local data.
 *  Override with NEXUS_DATA_DIR=/some/other/path */
export function nexusDataDir(): string {
  return process.env["NEXUS_DATA_DIR"] ?? path.join(os.homedir(), ".nexus");
}

/** Path to the workspace-scoped sub-directory.
 *  Equivalent to $NEXUS_DATA_DIR/workspaces/<workspaceId> */
export function nexusWorkspaceDir(workspaceId: string): string {
  return path.join(nexusDataDir(), "workspaces", workspaceId);
}

/** Default workspace identifier.
 *  Override with NEXUS_WORKSPACE_ID=my-project */
export function defaultWorkspaceId(): string {
  return process.env["NEXUS_WORKSPACE_ID"] ?? "default";
}

/** Default max input tokens for context packs.
 *  Override with NEXUS_DEFAULT_MAX_INPUT_TOKENS=8000 */
export function defaultMaxInputTokens(): number {
  const raw = process.env["NEXUS_DEFAULT_MAX_INPUT_TOKENS"];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12_000;
}

/** Default reserved output tokens (kept back for the model reply).
 *  Override with NEXUS_DEFAULT_RESERVED_TOKENS=2000 */
export function defaultReservedTokens(): number {
  const raw = process.env["NEXUS_DEFAULT_RESERVED_TOKENS"];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3_000;
}
