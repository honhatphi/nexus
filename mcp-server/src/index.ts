import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { loadConfig } from "./config.js";
import { MemgraphClient } from "./clients/memgraph.js";
import { ChromaDBClient } from "./clients/chromadb.js";
import { registerSyncTool } from "./tools/sync-service.js";
import { registerDetectChangesTool } from "./tools/detect-changes.js";
import { registerContextTool } from "./tools/context.js";
import { registerLedgerTools } from "./tools/ledger.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerContextPackTool } from "./tools/context-pack.js";
import { registerCodeSnippetTool } from "./tools/code-snippet.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerTaskWorkspaceTools } from "./tools/task-workspace.js";
import { registerAugmentTool } from "./tools/augment.js";
import {
  NexusCore,
  MemgraphGraphStore,
  ChromadbVectorStore,
  ExistingHybridRetriever,
  ExistingPipelineIndexer,
  FileLedgerStore,
  LedgerService,
  FileArtifactStore,
  ArtifactService,
  ContextPackBuilder,
} from "@nexus-hub/core";

async function main(): Promise<void> {
  const config = loadConfig();

  // ── Initialize DB clients ──────────────────────────────────
  const memgraph = new MemgraphClient(config.memgraph);
  const chromadb = new ChromaDBClient(config.chromadb);

  // ── A1: Bootstrap ChromaDB collection ─────────────────────
  try {
    await chromadb.bootstrap();
    console.log("  ChromaDB     : collection ready");
  } catch (err) {
    console.warn(`  ChromaDB     : bootstrap warning — ${err}`);
  }

  // ── A7: Ensure Memgraph uniqueness constraints ─────────────
  const constraints = [
    `CREATE CONSTRAINT ON (f:Function) ASSERT (f.name, f.file, f.service) IS NODE KEY`,
    `CREATE CONSTRAINT ON (r:APIRoute) ASSERT (r.path, r.method, r.service) IS NODE KEY`,
    `CREATE CONSTRAINT ON (s:Service) ASSERT s.name IS UNIQUE`,
    `CREATE CONSTRAINT ON (f:File) ASSERT (f.path, f.service) IS NODE KEY`,
  ];
  for (const cypher of constraints) {
    try {
      await memgraph.write(cypher, {});
    } catch {
      // Constraint already exists — safe to ignore
    }
  }
  console.log("  Memgraph     : constraints applied");

  const workspaceId = config.workspaceId;

  // ── Bootstrap NexusCore façade ─────────────────────────────
  const graphStore = new MemgraphGraphStore(memgraph);
  const vectorStore = new ChromadbVectorStore(chromadb);
  const retriever = new ExistingHybridRetriever(graphStore, vectorStore);
  const indexer = new ExistingPipelineIndexer(
    graphStore,
    vectorStore,
    workspaceId,
  );

  const core = new NexusCore({
    graph: graphStore,
    vector: vectorStore,
    retriever,
    indexer,
  });
  console.log("  NexusCore    : façade ready");

  // ── Bootstrap Memory Engine + Artifact Store ───────────────
  const fileLedgerStore = new FileLedgerStore(workspaceId);
  const ledgerService = new LedgerService(fileLedgerStore);
  const artifactService = new ArtifactService(
    new FileArtifactStore(workspaceId),
  );
  const contextPackBuilder = new ContextPackBuilder(
    graphStore,
    retriever,
    fileLedgerStore,
  );
  console.log(
    `  Memory       : ledger store ready (workspace: ${workspaceId})`,
  );
  console.log(`  Artifacts    : store ready`);
  console.log(`  ContextPack  : builder ready`);

  // ── HTTP transport (Streamable HTTP) ───────────────────────
  const httpServer = http.createServer(async (req, res) => {
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // MCP endpoint — create a fresh McpServer per connection (required for stateless HTTP)
    if (req.url === "/mcp") {
      const server = new McpServer({
        name: "nexus-kb",
        version: "0.1.0",
      });

      // ── New high-level tools (always registered) ──────────
      registerLedgerTools(server, ledgerService);
      registerArtifactTools(server, artifactService);
      registerContextPackTool(server, contextPackBuilder, config.budget);
      registerCodeSnippetTool(server, config.workspaceId);
      registerContextTool(server, core);
      registerDetectChangesTool(server, memgraph);
      registerSyncTool(server, memgraph, chromadb);
      registerAugmentTool(server, memgraph);
      registerWorkspaceTools(server, indexer);
      registerTaskWorkspaceTools(server, contextPackBuilder, config);

      // ── Legacy tools (opt-in via NEXUS_ENABLE_LEGACY_TOOLS=1) ─
      if (config.enableLegacyTools) {
        const { registerLegacyTools } =
          await import("./tools/legacy/register-legacy-tools.js");
        await registerLegacyTools(server, memgraph, chromadb);
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const PORT = config.server.port;
  httpServer.listen(PORT, () => {
    console.log(`Nexus MCP Server running on http://0.0.0.0:${PORT}`);
    console.log(`  MCP endpoint : POST /mcp`);
    console.log(`  Health check : GET  /health`);
    console.log(`  Memgraph     : ${config.memgraph.uri}`);
    console.log(`  ChromaDB     : ${config.chromadb.url}`);
  });

  // ── Graceful shutdown ──────────────────────────────────────
  const shutdown = async () => {
    console.log("\nShutting down…");
    await memgraph.close();
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
