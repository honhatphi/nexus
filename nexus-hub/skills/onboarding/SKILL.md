---
name: nexus-onboarding
description: "Use when trying to understand a new or unfamiliar service's architecture, structure, and key patterns."
tools: [search_knowledge_base, query_graph, get_process_flows]
---

## When to Use

- First time working with a service
- Need to understand how a service is structured
- Want to find key entry points and execution flows
- Exploring cross-service dependencies

## Workflow

1. **List services** — Read `nexus://services` resource for an overview of all indexed services.
2. **Service overview** — Read `nexus://overview/{service}` for high-level stats (files, functions, classes, languages).
3. **Explore clusters** — Read `nexus://clusters/{service}` to see auto-detected functional communities.
4. **Trace flows** — `get_process_flows` on key functions to understand execution paths.
5. **Search patterns** — `search_knowledge_base` for "architecture" or "overview" related to the service.
6. **Map dependencies** — `query_graph` to see cross-service communication:
   ```cypher
   MATCH (f:Function {service: "target-service"})-[:CALLS|IMPORTS]->(ext)
   WHERE ext.service <> "target-service"
   RETURN ext.name, ext.service, ext.file
   ```
7. **Infrastructure** — Query infra patterns:
   ```cypher
   MATCH (f:Function {service: "target-service"})-[:USES]->(i)
   RETURN i.kind, i.target, f.name
   ```

## Output Format

Produce a structured onboarding summary:

```
## Service: {name}
### Stats
- Files: X | Functions: Y | Classes: Z
### Languages
- Python (80%), YAML (20%)
### Key Communities
1. Community-0: [func_a, func_b, ...] — likely "data ingestion"
2. Community-1: [func_c, func_d, ...] — likely "API layer"
### Key Flows
1. main_dag → task_a → task_b → output
### External Dependencies
- Kafka topics: [topic_x, topic_y]
- PostgreSQL: [db_connection]
```
