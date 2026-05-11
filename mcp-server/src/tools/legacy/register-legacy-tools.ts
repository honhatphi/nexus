// ─────────────────────────────────────────────────────────────
// Legacy MCP tools (opt-in via NEXUS_ENABLE_LEGACY_TOOLS=1).
// Collected here so that index.ts can load them with a single
// dynamic import, keeping the hot path clean.
// ─────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemgraphClient } from "../../clients/memgraph.js";
import type { ChromaDBClient } from "../../clients/chromadb.js";
import { registerTools } from "../index.js";
import { registerParserTool } from "../parse-code.js";
import { registerAugmentTool } from "../augment.js";
import {
  registerProcessFlowsTool,
  registerResources,
} from "../resources.js";
import { registerScanRisksTool } from "../scan-risks.js";

export async function registerLegacyTools(
  server: McpServer,
  memgraph: MemgraphClient,
  chromadb: ChromaDBClient,
): Promise<void> {
  registerTools(server, memgraph, chromadb);
  registerParserTool(server);
  registerAugmentTool(server, memgraph);
  registerProcessFlowsTool(server, memgraph);
  registerResources(server, memgraph);
  registerScanRisksTool(server, memgraph);
}
