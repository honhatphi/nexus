// ─────────────────────────────────────────────────────────────
// OpenAPI Spec Parser — unit tests
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { parseOpenApiSpec, isOpenApiFile } from "../src/parser/openapi-spec.js";

// ── isOpenApiFile ─────────────────────────────────────────────

describe("isOpenApiFile", () => {
  it("recognizes openapi.yaml", () => {
    expect(isOpenApiFile("/services/api-gw/openapi.yaml")).toBe(true);
  });
  it("recognizes swagger.json", () => {
    expect(isOpenApiFile("/services/api-gw/swagger.json")).toBe(true);
  });
  it("recognizes api.yml", () => {
    expect(isOpenApiFile("/some/path/api.yml")).toBe(true);
  });
  it("ignores regular yaml files", () => {
    expect(isOpenApiFile("/services/api-gw/config.yaml")).toBe(false);
    expect(isOpenApiFile("/services/api-gw/docker-compose.yml")).toBe(false);
  });
});

// ── OpenAPI 3.x parsing ───────────────────────────────────────

describe("parseOpenApiSpec — OpenAPI 3.x", () => {
  const spec = `
openapi: "3.0.3"
info:
  title: Product API
  version: "1.0.0"
paths:
  /products:
    get:
      operationId: listProducts
      summary: List all products
      tags: [products]
    post:
      operationId: createProduct
      summary: Create a product
  /products/{id}:
    get:
      operationId: getProduct
    put:
      operationId: updateProduct
    delete:
      operationId: deleteProduct
`;

  it("returns infra patterns for each path+method", () => {
    const result = parseOpenApiSpec("openapi.yaml", spec);
    expect(result.infraPatterns.length).toBe(5);
  });

  it("all patterns have kind http_route_define", () => {
    const result = parseOpenApiSpec("openapi.yaml", spec);
    for (const p of result.infraPatterns) {
      expect(p.kind).toBe("http_route_define");
    }
  });

  it("extracts correct paths and methods", () => {
    const result = parseOpenApiSpec("openapi.yaml", spec);
    const listProducts = result.infraPatterns.find(
      (p) => p.target === "/products" && p.metadata?.method === "GET",
    );
    expect(listProducts).toBeDefined();
    expect(listProducts!.metadata?.operationId).toBe("listProducts");

    const deleteProduct = result.infraPatterns.find(
      (p) => p.target === "/products/{id}" && p.metadata?.method === "DELETE",
    );
    expect(deleteProduct).toBeDefined();
    expect(deleteProduct!.metadata?.operationId).toBe("deleteProduct");
  });

  it("stores source=openapi_spec in metadata", () => {
    const result = parseOpenApiSpec("openapi.yaml", spec);
    for (const p of result.infraPatterns) {
      expect(p.metadata?.source).toBe("openapi_spec");
    }
  });

  it("stores tags in metadata", () => {
    const result = parseOpenApiSpec("openapi.yaml", spec);
    const listProducts = result.infraPatterns.find(
      (p) => p.metadata?.operationId === "listProducts",
    );
    expect(listProducts!.metadata?.tags).toBe("products");
  });
});

// ── Swagger 2.x parsing ───────────────────────────────────────

describe("parseOpenApiSpec — Swagger 2.x", () => {
  const spec = `
swagger: "2.0"
info:
  title: Order API
  version: "1.0"
basePath: /v1
paths:
  /orders:
    get:
      operationId: listOrders
    post:
      operationId: createOrder
  /orders/{id}:
    get:
      operationId: getOrder
`;

  it("applies basePath prefix to paths", () => {
    const result = parseOpenApiSpec("swagger.yaml", spec);
    const listOrders = result.infraPatterns.find(
      (p) => p.metadata?.operationId === "listOrders",
    );
    expect(listOrders!.target).toBe("/v1/orders");
  });

  it("extracts all 3 operations", () => {
    const result = parseOpenApiSpec("swagger.yaml", spec);
    expect(result.infraPatterns.length).toBe(3);
  });
});

// ── Edge cases ────────────────────────────────────────────────

describe("parseOpenApiSpec — edge cases", () => {
  it("returns empty patterns for non-openapi yaml", () => {
    const result = parseOpenApiSpec(
      "openapi.yaml",
      "some_key: value\nother_key: 123",
    );
    expect(result.infraPatterns).toHaveLength(0);
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });

  it("handles empty paths object", () => {
    const result = parseOpenApiSpec(
      "openapi.yaml",
      `openapi: "3.0.0"\ninfo:\n  title: Empty\n  version: "1.0"\npaths: {}`,
    );
    expect(result.infraPatterns).toHaveLength(0);
    expect(result.parseErrors).toHaveLength(0);
  });

  it("returns parse error for invalid YAML", () => {
    const result = parseOpenApiSpec("openapi.yaml", ":: invalid: yaml: {{");
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.infraPatterns).toHaveLength(0);
  });
});
