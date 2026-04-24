// ─────────────────────────────────────────────────────────────
// Docker Compose Parser — unit tests
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  parseDockerCompose,
  isDockerComposeFile,
} from "../src/parser/docker-compose.js";

// ── isDockerComposeFile ───────────────────────────────────────

describe("isDockerComposeFile", () => {
  it("recognizes docker-compose.yml", () => {
    expect(isDockerComposeFile("/project/docker-compose.yml")).toBe(true);
  });
  it("recognizes docker-compose.yaml", () => {
    expect(isDockerComposeFile("/project/docker-compose.yaml")).toBe(true);
  });
  it("recognizes docker-compose.prod.yml", () => {
    expect(isDockerComposeFile("/project/docker-compose.prod.yml")).toBe(true);
  });
  it("recognizes docker-compose.override.yaml", () => {
    expect(isDockerComposeFile("/project/docker-compose.override.yaml")).toBe(
      true,
    );
  });
  it("ignores regular yaml files", () => {
    expect(isDockerComposeFile("/project/config.yaml")).toBe(false);
    expect(isDockerComposeFile("/project/openapi.yml")).toBe(false);
    expect(isDockerComposeFile("/project/docker-compose")).toBe(false);
  });
});

// ── parseDockerCompose ────────────────────────────────────────

const SAMPLE_COMPOSE = `
version: "3.9"
services:
  api:
    image: myorg/api:latest
    ports:
      - "8080:80"
    depends_on:
      - postgres
      - redis
    networks:
      - backend

  postgres:
    image: postgres:15
    ports:
      - "5432:5432"
    networks:
      - backend

  redis:
    image: redis:7
    ports:
      - "6379:6379"
    networks:
      - backend

networks:
  backend:
`;

describe("parseDockerCompose — basic extraction", () => {
  it("extracts one pattern per service", () => {
    const result = parseDockerCompose("docker-compose.yml", SAMPLE_COMPOSE);
    expect(result.infraPatterns.length).toBe(3);
  });

  it("stores service name as target", () => {
    const result = parseDockerCompose("docker-compose.yml", SAMPLE_COMPOSE);
    const names = result.infraPatterns.map((p) => p.target);
    expect(names).toContain("api");
    expect(names).toContain("postgres");
    expect(names).toContain("redis");
  });

  it("stores image in metadata", () => {
    const result = parseDockerCompose("docker-compose.yml", SAMPLE_COMPOSE);
    const api = result.infraPatterns.find((p) => p.target === "api");
    expect(api!.metadata?.image).toBe("myorg/api:latest");
  });

  it("stores ports in metadata", () => {
    const result = parseDockerCompose("docker-compose.yml", SAMPLE_COMPOSE);
    const api = result.infraPatterns.find((p) => p.target === "api");
    expect(api!.metadata?.ports).toContain("8080");
  });

  it("stores dependsOn in metadata", () => {
    const result = parseDockerCompose("docker-compose.yml", SAMPLE_COMPOSE);
    const api = result.infraPatterns.find((p) => p.target === "api");
    expect(api!.metadata?.dependsOn).toContain("postgres");
    expect(api!.metadata?.dependsOn).toContain("redis");
  });

  it("stores networks in metadata", () => {
    const result = parseDockerCompose("docker-compose.yml", SAMPLE_COMPOSE);
    const api = result.infraPatterns.find((p) => p.target === "api");
    expect(api!.metadata?.networks).toContain("backend");
  });

  it("stores source=docker_compose in metadata", () => {
    const result = parseDockerCompose("docker-compose.yml", SAMPLE_COMPOSE);
    for (const p of result.infraPatterns) {
      expect(p.metadata?.source).toBe("docker_compose");
    }
  });
});

describe("parseDockerCompose — edge cases", () => {
  it("handles depends_on as object (healthcheck syntax)", () => {
    const compose = `
version: "3"
services:
  app:
    image: myapp
    depends_on:
      db:
        condition: service_healthy
`;
    const result = parseDockerCompose("docker-compose.yml", compose);
    const app = result.infraPatterns.find((p) => p.target === "app");
    expect(app!.metadata?.dependsOn).toContain("db");
  });

  it("handles service with build instead of image", () => {
    const compose = `
version: "3"
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
`;
    const result = parseDockerCompose("docker-compose.yml", compose);
    const app = result.infraPatterns.find((p) => p.target === "app");
    expect(app!.metadata?.image).toBe("<local-build>");
  });

  it("returns empty patterns for invalid yaml", () => {
    const result = parseDockerCompose(
      "docker-compose.yml",
      "key: [unclosed bracket\nother: {broken",
    );
    expect(result.infraPatterns).toHaveLength(0);
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });

  it("returns empty patterns for compose without services", () => {
    const result = parseDockerCompose(
      "docker-compose.yml",
      "version: '3'\nnetworks:\n  default: {}",
    );
    expect(result.infraPatterns).toHaveLength(0);
    expect(result.parseErrors).toHaveLength(0);
  });
});
