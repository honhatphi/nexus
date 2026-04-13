# Sync Workspace — Agentic Workflow

Automated workflow to scan all `/services`, extract knowledge, ingest into the Shared Graph & Vector DB, then analyze patterns to generate Global Skills.

---

## Overview

```
Scan /services → Parse (tree-sitter) → Upsert Graph + Vector → Detect Patterns → Generate Global Skills
```

---

## Step 1 — Scan All Projects in `/services`

- List all service directories in `/services/*`.
- Each service is declared in `/nexus-config.yaml` with its corresponding tech stack.
- Collect metadata: service name, language, path.

```
Input:  /services/*
Output: [
  { name: "api-gateway",          path: "./services/api-gateway",          tech: "Go"     },
  { name: "auth-service",         path: "./services/auth-service",         tech: "Go"     },
  { name: "payment-service",      path: "./services/payment-service",      tech: "Python" },
  { name: "notification-service", path: "./services/notification-service", tech: "PHP"    },
]
```

---

## Step 2 — Call `universal-parser` to Extract Knowledge

For each service, use the MCP Tool `sync_service_knowledge`:

```
sync_service_knowledge({
  service_path: "./services/api-gateway",
  force_update: false
})
```

The tool automatically:

1. Scans all source code files (`.go`, `.py`, `.php`, `.ts`).
2. Calls `universal-parser.ts` for each file.
3. Extracts: **Functions**, **Parameters**, **Return Types**, **Function Calls**.
4. Normalizes into Unified Schema JSON.

**Output per service:**

```jsonc
{
  "service": "api-gateway",
  "language": "go",
  "filesScanned": 42,
  "functionsExtracted": 156,
  "relationshipsCreated": 320,
  "vectorsUpserted": 156,
}
```

---

## Step 3 — Ingest Data into Shared Databases

### 3a. Memgraph (Shared Graph)

Create/update nodes and relationships:

```cypher
// Node for each function
MERGE (f:Function {name: $name, file: $file, service: $service})
SET f.language    = $language,
    f.returnType  = $returnType,
    f.startLine   = $startLine,
    f.endLine     = $endLine,
    f.updatedAt   = timestamp()

// Relationship for each function call
MERGE (caller:Function {name: $callerName, file: $callerFile})
MERGE (callee:Function {name: $calleeName})
MERGE (caller)-[:CALLS {line: $line}]->(callee)

// Relationship file → service
MERGE (s:Service {name: $service})
MERGE (fi:File {path: $file})
MERGE (fi)-[:BELONGS_TO]->(s)
MERGE (f)-[:DEFINED_IN]->(fi)
```

### 3b. ChromaDB (Shared Vector)

Ingest each function signature + body context as a vector document:

```
ID:       "{service}::{file}::{functionName}"
Document: "{functionSignature}\n{parameterList}\n{returnType}"
Metadata: { service, file, language, startLine, endLine }
```

---

## Step 4 — Analyze Common Patterns Across Microservices

After all services have been ingested, the agent performs cross-service analysis:

### 4a. Query Graph to Find Patterns

```cypher
// Find functions with the same name appearing in multiple services
MATCH (f:Function)
WITH f.name AS funcName, collect(DISTINCT f.service) AS services, count(*) AS cnt
WHERE cnt > 1
RETURN funcName, services, cnt
ORDER BY cnt DESC
LIMIT 20

// Find cross-service API call patterns
MATCH (caller:Function)-[:CALLS]->(callee:Function)
WHERE caller.service <> callee.service
RETURN caller.service, caller.name, callee.service, callee.name

// Find common error handling patterns
MATCH (f:Function)-[:CALLS]->(handler:Function)
WHERE handler.name CONTAINS 'error' OR handler.name CONTAINS 'Error'
   OR handler.name CONTAINS 'handle' OR handler.name CONTAINS 'catch'
RETURN f.service, f.name, handler.name, count(*) AS frequency
ORDER BY frequency DESC
```

### 4b. Query Vectors to Find Similar Code

```
search_knowledge_base({ query: "error handling middleware", topK: 10 })
search_knowledge_base({ query: "HTTP client retry logic", topK: 10 })
search_knowledge_base({ query: "authentication token validation", topK: 10 })
```

---

## Step 5 — Generate Global Skills in `/nexus-hub/skills`

Based on the analysis results, the agent creates Global Skill files:

```
nexus-hub/skills/
├── error-handling.md          ← Common error handling pattern
├── inter-service-calls.md     ← Cross-service API call conventions
├── auth-middleware.md          ← Auth middleware pattern
├── retry-logic.md              ← Retry & circuit breaker pattern
└── logging-standards.md        ← Standard logging format
```

Each skill file contains:

- **Pattern description** — Summary of the discovered pattern.
- **Applicable services** — List of services currently using this pattern.
- **Reference code** — Best-practice code examples from the strongest service.
- **Anti-patterns** — Incorrect implementations found during comparison.
- **Recommendations** — Improvement suggestions for non-compliant services.

---

## Flow Diagram

```
┌──────────────────────────────┐
│  1. List /services/*         │
│     Read nexus-config.yaml   │
└──────────────┬───────────────┘
               ▼
       ┌───────┴───────┐
       │  For each      │
       │  service:      │
       └───────┬───────┘
               ▼
┌──────────────────────────────┐
│  2. sync_service_knowledge   │
│     universal-parser →       │
│     extract functions        │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  3a. Upsert → Memgraph      │
│  3b. Upsert → ChromaDB      │
└──────────────┬───────────────┘
               ▼
       ┌───────┴───────┐
       │  All           │
       │  services done? │
       └───────┬───────┘
          Yes  ▼
┌──────────────────────────────┐
│  4. Cross-service analysis   │
│     Graph queries +          │
│     Vector similarity        │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  5. Generate Global Skills   │
│     → /nexus-hub/skills/     │
└──────────────────────────────┘
```

---

## Schedule

| Trigger       | Action                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| **Manual**    | Agent runs when user requests sync                                     |
| **On Push**   | Hook `post-push` runs `sync_service_knowledge` for the changed service |
| **Scheduled** | Cron job runs full sync daily, pattern analysis weekly                 |
