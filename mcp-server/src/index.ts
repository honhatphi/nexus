import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { loadConfig } from "./config.js";
import { MemgraphClient } from "./clients/memgraph.js";
import { ChromaDBClient } from "./clients/chromadb.js";
import { registerTools } from "./tools/index.js";
import { registerParserTool } from "./tools/parse-code.js";
import { registerSyncTool } from "./tools/sync-service.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // ── Initialize DB clients ──────────────────────────────────
  const memgraph = new MemgraphClient(config.memgraph);
  const chromadb = new ChromaDBClient(config.chromadb);

  // ── Create MCP server ──────────────────────────────────────
  const server = new McpServer({
    name: "nexus-kb",
    version: "0.1.0",
  });

  registerTools(server, memgraph, chromadb);
  registerParserTool(server);
  registerSyncTool(server, memgraph, chromadb);

  // ── HTTP transport (Streamable HTTP) ───────────────────────
  const httpServer = http.createServer(async (req, res) => {
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // MCP endpoint
    if (req.url === "/mcp") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
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
