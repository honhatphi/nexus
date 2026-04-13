#!/usr/bin/env node
/**
 * Nexus — PreToolUse safety hook
 *
 * Classifies every tool call as ALLOW / ASK / DENY before autopilot executes it.
 * Aligns with the Zero Regression Policy defined in copilot-instructions.md.
 *
 * Input (stdin):  JSON with at least { tool_name, tool_input }
 * Output (stdout): JSON  { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
 * Exit codes: 0 = success, 2 = hard block
 */

"use strict";

// ─── Dangerous pattern lists ──────────────────────────────────────────────────

/**
 * DENY — block immediately, no user prompt.
 * Matches operations with no safe use-case inside this repo.
 */
const DENY_PATTERNS = [
  // Wipe entire filesystem or root paths
  {
    re: /\brm\s+(-[^\s]*f[^\s]*)?\s+-[^\s]*r.*(\/\s*$|\/\*|\s+\/$|\s+\/\*)/i,
    label: "rm -rf on root/filesystem",
  },
  { re: /\brm\s+-rf\s+(\/\s*$|\/\*)/i, label: "rm -rf / or /*" },
  // Low-level disk write
  { re: /\bdd\s+if=/i, label: "dd disk write" },
  { re: /\bmkfs\b/i, label: "mkfs — format filesystem" },
  // Force-push to protected branches (master/main)
  {
    re: /\bgit\s+push\s+.*(-f|--force)\s+.*\b(master|main)\b/i,
    label: "git force-push to master/main",
  },
  {
    re: /\bgit\s+push\s+.*\b(master|main)\b.*(-f|--force)/i,
    label: "git force-push to master/main",
  },
  // Drop production databases
  { re: /\bDROP\s+(DATABASE|SCHEMA)\s+\w+/i, label: "DROP DATABASE/SCHEMA" },
];

/**
 * ASK — require explicit user confirmation before proceeding.
 */
const ASK_PATTERNS = [
  // Docker destructive operations (check BEFORE generic rm)
  {
    re: /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)/i,
    label: "docker destructive operation",
  },
  // ANY file deletion — always confirm (negative lookbehind excludes docker rm)
  { re: /(?<!\bdocker\s)\brm\s+/i, label: "file deletion (rm)" },
  // Move to /dev/null
  // Git destructive operations
  { re: /\bgit\s+reset\s+--hard\b/i, label: "git reset --hard" },
  { re: /\bgit\s+reset\b/i, label: "git reset (may lose changes)" },
  {
    re: /\bgit\s+stash\s+drop\b/i,
    label: "git stash drop (loses stashed changes)",
  },
  {
    re: /\bgit\s+clean\s+(-[^\s]*[fd])/i,
    label: "git clean -fd (removes untracked files)",
  },
  { re: /\bgit\s+push\s+.*(-f|--force)/i, label: "git force-push" },
  {
    re: /\bgit\s+push\s+(-u\s+)?origin\s+(master|main)\b/i,
    label: "direct push to master/main",
  },
  { re: /\bgit\s+checkout\s+(-f|--force)/i, label: "git checkout --force" },
  // Amend committed history
  {
    re: /\bgit\s+commit\s+--amend\b/i,
    label: "git commit --amend (rewrites history)",
  },
  { re: /\bgit\s+rebase\b/i, label: "git rebase (rewrites history)" },
  // Drop DB table
  { re: /\bDROP\s+TABLE\b/i, label: "DROP TABLE" },
  { re: /\bTRUNCATE\s+TABLE\b/i, label: "TRUNCATE TABLE" },
  // Pipe remote shell script
  {
    re: /\b(curl|wget)\b.*\|\s*(bash|sh|zsh)/i,
    label: "pipe remote content to shell",
  },
  // Kill signals
  { re: /\bkill\s+-9\b/i, label: "kill -9 (SIGKILL)" },
  // chmod 777 on broad paths
  { re: /\bchmod\s+(-R\s+)?777\b/i, label: "chmod 777 (world-writable)" },
  // Delete branches
  { re: /\bgit\s+branch\s+(-D|-d)\b/i, label: "git branch delete" },
  {
    re: /\bgit\s+push\s+origin\s+--delete\b/i,
    label: "git push --delete (remote branch delete)",
  },
  // npm/package destructive
  { re: /\bnpm\s+(unpublish|deprecate)\b/i, label: "npm unpublish/deprecate" },
  // Overwrite files unsafely
  { re: /\b>\s*\/[^\s]+/i, label: "redirect overwrite to absolute path" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function respond(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
}

function checkCommand(cmd) {
  for (const { re, label } of DENY_PATTERNS) {
    if (re.test(cmd)) {
      return { decision: "deny", reason: `🚫 BLOCKED: ${label}` };
    }
  }
  for (const { re, label } of ASK_PATTERNS) {
    if (re.test(cmd)) {
      return {
        decision: "ask",
        reason: `⚠️  Potentially destructive: ${label}`,
      };
    }
  }
  return { decision: "allow", reason: "safe" };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  /** @type {{ tool_name?: string; tool_input?: Record<string, unknown> }} */
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // Unparseable input → allow (fail open so hook doesn't break normal flow)
    respond("allow", "hook: could not parse input JSON");
    process.exit(0);
  }

  const toolName = (input.tool_name || "").toLowerCase();

  // Only inspect tools that execute shell commands
  if (
    toolName === "run_in_terminal" ||
    toolName === "bash" ||
    toolName === "shell"
  ) {
    const cmd = String(
      input.tool_input?.command ?? input.tool_input?.cmd ?? "",
    );

    if (cmd.trim() === "") {
      respond("allow", "no command to check");
      process.exit(0);
    }

    const { decision, reason } = checkCommand(cmd);

    if (decision === "deny") {
      respond("deny", reason);
      process.exit(2); // hard block
    }

    respond(decision, reason);
    process.exit(0);
  }

  // All other tools → allow
  respond("allow", "non-terminal tool");
  process.exit(0);
}

main().catch((err) => {
  // Fail open — hook errors should not block normal agent flow
  respond("allow", `hook error: ${err.message}`);
  process.exit(0);
});
