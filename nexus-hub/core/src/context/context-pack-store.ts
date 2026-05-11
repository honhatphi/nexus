// ─────────────────────────────────────────────────────────────
// ContextPackStore — persist context packs to local disk.
// Path: ~/.nexus/workspaces/<workspaceId>/context-packs/<id>.json
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import type { ContextPack } from "../contracts/context-pack.js";
import { nexusWorkspaceDir } from "../env.js";

export class ContextPackStore {
  async save(workspaceId: string, pack: ContextPack): Promise<void> {
    try {
      const dir = path.join(nexusWorkspaceDir(workspaceId), "context-packs");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `${pack.id}.json`),
        JSON.stringify(pack, null, 2),
      );
    } catch {
      // Non-critical — persistence failure doesn't block the tool response.
    }
  }
}
