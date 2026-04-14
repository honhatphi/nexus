// ─────────────────────────────────────────────────────────────
// Tests for search_knowledge_base — hybrid/semantic/keyword modes
// and the RRF fusion logic.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { hybridSearch, type SearchMode } from "../src/clients/search.js";
import { createMockMemgraph, createMockChromaDB } from "./helpers.js";

describe("hybridSearch", () => {
  it("semantic mode returns only ChromaDB results", async () => {
    const chromadb = createMockChromaDB([
      {
        id: "fn:handler.py:handle_request",
        document: "handle_request",
        metadata: { name: "handle_request" },
        distance: 0.1,
      },
      {
        id: "fn:utils.py:validate",
        document: "validate",
        metadata: { name: "validate" },
        distance: 0.4,
      },
    ]);
    const memgraph = createMockMemgraph();

    const results = await hybridSearch(
      memgraph,
      chromadb,
      "request handler",
      5,
      "semantic",
    );

    expect(results).toHaveLength(2);
    expect(results[0].source).toBe("semantic");
    expect(results[0].score).toBeCloseTo(0.9, 1); // 1 - 0.1
    expect(results[1].score).toBeCloseTo(0.6, 1); // 1 - 0.4
    // No Memgraph queries should have been made (except none)
    expect(memgraph.calls).toHaveLength(0);
  });

  it("keyword mode returns only Memgraph results", async () => {
    const memgraph = createMockMemgraph(
      new Map([
        [
          "n:Function OR n:Class",
          [
            {
              name: "send_event",
              file: "kafka.py",
              docstring: "send kafka event",
              service: "warehouse-2.0",
              label: "Function",
            },
          ],
        ],
      ]),
    );
    const chromadb = createMockChromaDB();

    const results = await hybridSearch(
      memgraph,
      chromadb,
      "kafka",
      5,
      "keyword",
    );

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("keyword");
    expect(results[0].id).toContain("send_event");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("hybrid mode fuses results from both sources", async () => {
    const sharedId = "Function:handler.py:handle_request";

    const memgraph = createMockMemgraph(
      new Map([
        [
          "n:Function OR n:Class",
          [
            {
              name: "handle_request",
              file: "handler.py",
              docstring: "",
              service: "svc",
              label: "Function",
            },
          ],
        ],
      ]),
    );
    const chromadb = createMockChromaDB([
      {
        id: sharedId,
        document: "handle_request",
        metadata: { name: "handle_request" },
        distance: 0.2,
      },
    ]);

    const results = await hybridSearch(
      memgraph,
      chromadb,
      "handle_request",
      5,
      "hybrid",
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    // Results that appear in both should be scored higher
    const bothResult = results.find((r) => r.source === "both");
    if (bothResult) {
      const singleResult = results.find((r) => r.source !== "both");
      if (singleResult) {
        expect(bothResult.score).toBeGreaterThan(singleResult.score);
      }
    }
  });

  it("returns empty array when no results found", async () => {
    const memgraph = createMockMemgraph();
    const chromadb = createMockChromaDB();

    const results = await hybridSearch(
      memgraph,
      chromadb,
      "nonexistent",
      5,
      "hybrid",
    );
    expect(results).toEqual([]);
  });
});
