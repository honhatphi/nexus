export interface Config {
  memgraph: {
    uri: string;
    user: string;
    password: string;
  };
  chromadb: {
    url: string;
    token: string;
    collection: string;
  };
  server: {
    port: number;
  };
  /** Default workspace ID used when no workspace_id is passed by the caller. */
  workspaceId: string;
  /** Default token budget applied to context-pack builds. */
  budget: {
    maxInputTokens: number;
    reservedOutputTokens: number;
  };
  /** Token budget used when spawning a task workspace context pack. */
  taskWorkspace: {
    maxInputTokens: number;
  };
  /** When true, registers legacy low-level tools (query_graph, search_knowledge_base, etc.) */
  enableLegacyTools: boolean;
  /**
   * Default workspace root directory used when no cwd is provided to workspace tools.
   * Maps to NEXUS_WORKSPACE_ROOT env var.
   */
  workspaceRoot: string;
}

export function loadConfig(): Config {
  return {
    memgraph: {
      uri: process.env.MEMGRAPH_URI || "bolt://localhost:17687",
      user: process.env.MEMGRAPH_USER || "",
      password: process.env.MEMGRAPH_PASSWORD || "",
    },
    chromadb: {
      url: process.env.CHROMADB_URL || "http://localhost:18000",
      token: process.env.CHROMADB_TOKEN || "",
      collection: process.env.CHROMADB_COLLECTION || "nexus_codebase",
    },
    server: {
      port: Number(process.env.MCP_SERVER_PORT) || 13100,
    },
    workspaceId: process.env.NEXUS_WORKSPACE_ID || "default",
    budget: {
      maxInputTokens:
        parseInt(process.env.NEXUS_DEFAULT_MAX_INPUT_TOKENS ?? "", 10) ||
        12_000,
      reservedOutputTokens:
        parseInt(process.env.NEXUS_DEFAULT_RESERVED_TOKENS ?? "", 10) || 3_000,
    },
    taskWorkspace: {
      maxInputTokens:
        parseInt(process.env.NEXUS_TASK_MAX_INPUT_TOKENS ?? "", 10) || 16_000,
    },
    enableLegacyTools: process.env.NEXUS_ENABLE_LEGACY_TOOLS === "1",
    workspaceRoot: process.env.NEXUS_WORKSPACE_ROOT ?? "",
  };
}
