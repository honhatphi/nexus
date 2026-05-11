// ─────────────────────────────────────────────────────────────
// SourceResolver — produce candidate absolute paths for a
// manifest source string without touching the filesystem.
// ─────────────────────────────────────────────────────────────

import path from "node:path";

export interface SourceResolverOptions {
  /** Override NEXUS_WORKSPACE_ROOT env var for testing. */
  workspaceRoot?: string;
}

export class SourceResolver {
  /**
   * Return an ordered list of candidate absolute paths for `source`.
   *
   * Resolution order:
   *   1. If `source` is already absolute → `[source]`
   *   2. Otherwise:
   *      a. `NEXUS_WORKSPACE_ROOT + source` (or options.workspaceRoot)
   *      b. `process.cwd() + source`
   *
   * The caller is responsible for trying each candidate in order and
   * using the first one that resolves to a readable file.
   */
  resolveCandidates(source: string, options?: SourceResolverOptions): string[] {
    if (path.isAbsolute(source)) {
      return [source];
    }

    const wsRoot = options?.workspaceRoot ?? process.env.NEXUS_WORKSPACE_ROOT;

    const candidates: string[] = [];
    if (wsRoot) {
      candidates.push(path.join(wsRoot, source));
    }
    candidates.push(path.join(process.cwd(), source));
    return candidates;
  }
}
