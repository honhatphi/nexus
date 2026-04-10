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
}

export function loadConfig(): Config {
  return {
    memgraph: {
      uri: process.env.MEMGRAPH_URI || "bolt://localhost:7687",
      user: process.env.MEMGRAPH_USER || "",
      password: process.env.MEMGRAPH_PASSWORD || "",
    },
    chromadb: {
      url: process.env.CHROMADB_URL || "http://localhost:8000",
      token: process.env.CHROMADB_TOKEN || "",
      collection: process.env.CHROMADB_COLLECTION || "nexus_codebase",
    },
    server: {
      port: Number(process.env.MCP_SERVER_PORT) || 3100,
    },
  };
}
