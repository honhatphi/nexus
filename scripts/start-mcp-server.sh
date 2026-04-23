#!/bin/bash
# Nexus MCP Server — startup script
# Used by launchd to start the MCP server with proper environment

export PATH="/Users/CPS-MKT1-D02072/.nvm/versions/node/v24.13.0/bin:$PATH"
export MEMGRAPH_URI="bolt://localhost:17687"
export CHROMADB_URL="http://localhost:18000"
export CHROMADB_COLLECTION="nexus_codebase"
export MCP_SERVER_PORT="13100"
export NODE_ENV="production"

cd /Users/CPS-MKT1-D02072/Workspace/Nexus/mcp-server
exec node dist/index.js
