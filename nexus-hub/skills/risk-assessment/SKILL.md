---
name: risk-assessment
description: "Use when assessing risks before or after a code change, or when answering 'is this safe to deploy?' questions. Guides use of scan_risks and interpret results."
---

# Risk Assessment Skill

## When to Use

- Before merging a PR that touches hotspot functions
- After a sync when a developer asks "is this safe?"
- When `detect_changes` returns `contractDrift` or `hotspots`
- Periodic health checks on a service

## Workflow

### 1. Check KB Freshness First

```
check_staleness({ service: "<service>" })
```

If `stale = true` → inform the user KB may not reflect latest code.

### 2. Run scan_risks

```
scan_risks({
  service: "<service>",
  riskTypes: ["security", "stability", "performance"],
  threshold: 0.5
})
```

### 3. Interpret Results

| `breakingRisk`                | Action                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `HIGH` (critical items exist) | **Block** — flag contract drift or critical hotspots. Developer must address before proceeding. |
| `MEDIUM` (high items exist)   | **Warn** — surface hotspots. Proceed with caution.                                              |
| `LOW` / `NONE`                | Safe to proceed.                                                                                |

### 4. Format Report for Developer

Use this template:

```
## Nexus KB Quality Report — <service> @ <lastSyncCommit>

### Breaking Risk: 🔴 HIGH / 🟡 MEDIUM / 🟢 LOW

### Contract Drift
<list removed/changed routes — each is a potential breaking change for callers>

### Top Stability Hotspots
<top 5 hotspot functions with score, blast_radius, fan_in>

### Security Flags
<list unprotected routes or high-fanin DB functions>

### Recommended Actions
1. <action 1>
2. <action 2>
```

## Risk Thresholds (from nexus-config.yaml)

| Gate                         | Value | Meaning                                           |
| ---------------------------- | ----- | ------------------------------------------------- |
| `max_contract_drift`         | 0     | ANY removed route = critical risk                 |
| `max_blast_radius_increase`  | 20%   | Blast radius growing > 20% = high risk            |
| `min_test_coverage_hotspot`  | 80%   | Hotspot functions (score ≥ 0.7) need 80% coverage |
| `hotspot_critical_threshold` | 0.7   | Score ≥ 0.7 = critical hotspot                    |

## Integration with Other Tools

- `detect_changes` → includes `architectureDiff` + `hotspots` automatically after Phase C
- `query_graph` for custom Cypher risk queries:

```cypher
-- Find functions with blast radius > 20 in a service
MATCH (f:Function {service: "warehouse-2.0"})-[:CALLS]->(callee:Function)
WITH f, count(DISTINCT callee) AS blastRadius
WHERE blastRadius > 20
RETURN f.name, f.file, blastRadius
ORDER BY blastRadius DESC
```

## CandidatePattern Review

After sync, check for unknown patterns:

```
augment({ pattern: "candidate", action: "listCandidates", service: "<service>" })
```

Approve known patterns:

```
augment({ action: "promoteCandidate", candidateId: "<id>", approvedAs: "kafka_produce" })
```

## Anti-patterns

- Do NOT run scan_risks as a substitute for sync — KB must be fresh first.
- Do NOT ignore `critical` severity items without developer acknowledgment.
- Do NOT use threshold=0 in production — it returns too much noise.
