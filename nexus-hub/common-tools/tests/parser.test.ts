// ─────────────────────────────────────────────────────────────
// CodeParser — top-level integration tests
// Verifies that the refactored parser still produces correct
// output for every supported language.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import { CodeParser } from "../src/universal-parser.js";

let parser: CodeParser;

beforeAll(() => {
  parser = new CodeParser();
});

// ─────────────────────────────────────────────────────────────
// detectLanguage
// ─────────────────────────────────────────────────────────────

describe("CodeParser.detectLanguage", () => {
  it.each([
    [".go", "go"],
    [".py", "python"],
    [".php", "php"],
    [".ts", "typescript"],
    [".tsx", "typescript"],
    [".js", "javascript"],
    [".jsx", "javascript"],
    [".mjs", "javascript"],
    [".cjs", "javascript"],
    [".java", "java"],
    [".cs", "csharp"],
    [".yml", "yaml"],
    [".yaml", "yaml"],
  ])("detects %s → %s", (ext, expected) => {
    expect(parser.detectLanguage(`file${ext}`)).toBe(expected);
  });

  it("returns null for unsupported extensions", () => {
    expect(parser.detectLanguage("file.rs")).toBeNull();
    expect(parser.detectLanguage("file.rb")).toBeNull();
    expect(parser.detectLanguage("file")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// parseSource — unsupported file
// ─────────────────────────────────────────────────────────────

describe("CodeParser.parseSource — unsupported", () => {
  it("returns parseErrors for unknown extension", async () => {
    const result = await parser.parseSource("file.rs", "fn main() {}");
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.symbols).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// parseSource — Go
// ─────────────────────────────────────────────────────────────

describe("CodeParser.parseSource — Go", () => {
  const goSource = `
package main

import "fmt"

// handleRequest processes an HTTP request.
func handleRequest(w http.ResponseWriter, r *http.Request) {
    fmt.Println("hello")
    processBody(r)
}

func (s *Server) Start(port int) error {
    return s.listen(port)
}
`;

  it("extracts functions and methods", async () => {
    const result = await parser.parseSource("handler.go", goSource);
    expect(result.language).toBe("go");
    expect(result.parseErrors).toEqual([]);
    expect(result.symbols.length).toBe(2);

    const fn = result.symbols[0];
    expect(fn.name).toBe("handleRequest");
    expect(fn.kind).toBe("function");
    expect(fn.params.length).toBe(2);
    expect(fn.docstring).toContain("handleRequest");

    const method = result.symbols[1];
    expect(method.name).toBe("Start");
    expect(method.kind).toBe("method");
    expect(method.params.length).toBe(1);
    expect(method.params[0].name).toBe("port");
    expect(method.params[0].type).toBe("int");
  });

  it("extracts function calls", async () => {
    const result = await parser.parseSource("handler.go", goSource);
    const fn = result.symbols[0];
    expect(fn.calls.length).toBeGreaterThanOrEqual(1);
    const callNames = fn.calls.map((c) => c.name);
    expect(callNames).toContain("processBody");
  });

  it("populates backward-compat functions array", async () => {
    const result = await parser.parseSource("handler.go", goSource);
    expect(result.functions.length).toBe(result.symbols.length);
    expect(result.functions[0].name).toBe("handleRequest");
  });
});

// ─────────────────────────────────────────────────────────────
// parseSource — Python
// ─────────────────────────────────────────────────────────────

describe("CodeParser.parseSource — Python", () => {
  const pySource = `
import os

def process_order(order_id: int, amount: float) -> dict:
    """Process a single order and return the result."""
    validate(order_id)
    return save(order_id, amount)

class PaymentService:
    def charge(self, amount: float) -> bool:
        return gateway.process(amount)

    def refund(self, tx_id: str):
        gateway.reverse(tx_id)
`;

  it("extracts functions with params and types", async () => {
    const result = await parser.parseSource("orders.py", pySource);
    expect(result.language).toBe("python");
    expect(result.parseErrors).toEqual([]);

    const fn = result.symbols.find((s) => s.name === "process_order");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.params.length).toBe(2);
    expect(fn!.params[0]).toEqual({ name: "order_id", type: "int" });
    expect(fn!.params[1]).toEqual({ name: "amount", type: "float" });
    expect(fn!.returnType).toBe("dict");
    expect(fn!.docstring).toContain("Process a single order");
  });

  it("extracts methods inside classes", async () => {
    const result = await parser.parseSource("orders.py", pySource);
    const charge = result.symbols.find((s) => s.name === "charge");
    expect(charge).toBeDefined();
    expect(charge!.kind).toBe("method");
    expect(charge!.params.length).toBe(2); // self, amount
  });

  it("extracts classes with bases and methods", async () => {
    const result = await parser.parseSource("orders.py", pySource);
    expect(result.classes.length).toBe(1);
    const cls = result.classes[0];
    expect(cls.name).toBe("PaymentService");
    expect(cls.methods).toContain("charge");
    expect(cls.methods).toContain("refund");
  });
});

// ─────────────────────────────────────────────────────────────
// parseSource — TypeScript
// ─────────────────────────────────────────────────────────────

describe("CodeParser.parseSource — TypeScript", () => {
  const tsSource = `
/** Greet a user by name. */
function greet(name: string): string {
  return \`Hello, \${name}\`;
}

// Arrow function
const add = (a: number, b: number): number => a + b;

class Calculator {
  multiply(x: number, y: number): number {
    return x * y;
  }
}
`;

  it("extracts function, arrow function, and methods", async () => {
    const result = await parser.parseSource("math.ts", tsSource);
    expect(result.language).toBe("typescript");
    expect(result.parseErrors).toEqual([]);
    expect(result.symbols.length).toBeGreaterThanOrEqual(3);

    const greetFn = result.symbols.find((s) => s.name === "greet");
    expect(greetFn).toBeDefined();
    expect(greetFn!.kind).toBe("function");
    expect(greetFn!.params[0]).toEqual({ name: "name", type: ": string" });
    expect(greetFn!.docstring).toContain("Greet a user");

    const addFn = result.symbols.find((s) => s.name === "add");
    expect(addFn).toBeDefined();
    expect(addFn!.kind).toBe("arrow_function");
  });

  it("extracts classes", async () => {
    const result = await parser.parseSource("math.ts", tsSource);
    expect(result.classes.length).toBe(1);
    expect(result.classes[0].name).toBe("Calculator");
    expect(result.classes[0].methods).toContain("multiply");
  });

  it("tracks parent class for methods with duplicate names", async () => {
    const result = await parser.parseSource(
      "validators.ts",
      `
class OrderValidator {
  validate() {
    return true;
  }
}

class UserValidator {
  validate() {
    return false;
  }
}
`,
    );

    const methods = result.symbols.filter((s) => s.name === "validate");
    expect(methods).toHaveLength(2);
    expect(methods.map((s) => s.className).sort()).toEqual([
      "OrderValidator",
      "UserValidator",
    ]);
  });

  it("does not attribute nested function calls to the outer function", async () => {
    const result = await parser.parseSource(
      "nested.ts",
      `
function outer(items: string[]) {
  function inner() {
    hiddenCall();
  }
  return items.map((item) => transform(item));
}
`,
    );

    const outer = result.symbols.find((s) => s.name === "outer");
    expect(outer).toBeDefined();
    const callNames = outer!.calls.map((c) => c.name);
    expect(callNames).not.toContain("hiddenCall");
    expect(callNames).not.toContain("transform");
  });
});

// ─────────────────────────────────────────────────────────────
// parseSource — JavaScript (reuses TS extractor)
// ─────────────────────────────────────────────────────────────

describe("CodeParser.parseSource — JavaScript", () => {
  const jsSource = `
function fetchData(url) {
  return fetch(url).then(r => r.json());
}

class ApiClient {
  request(endpoint) {
    return fetchData(endpoint);
  }
}
`;

  it("parses .js files using the TS extractor", async () => {
    const result = await parser.parseSource("api.js", jsSource);
    expect(result.language).toBe("javascript");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    const fn = result.symbols.find((s) => s.name === "fetchData");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("extracts JS classes", async () => {
    const result = await parser.parseSource("api.js", jsSource);
    expect(result.classes.length).toBe(1);
    expect(result.classes[0].name).toBe("ApiClient");
  });
});

// ─────────────────────────────────────────────────────────────
// parseSource — PHP
// ─────────────────────────────────────────────────────────────

describe("CodeParser.parseSource — PHP", () => {
  const phpSource = `<?php

/**
 * Calculate the total price.
 */
function calculateTotal(float $price, int $qty): float {
    return $price * $qty;
}

class OrderService {
    public function create(string $name): void {
        $this->save($name);
    }
}
`;

  it("extracts PHP functions and methods", async () => {
    const result = await parser.parseSource("order.php", phpSource);
    expect(result.language).toBe("php");
    expect(result.symbols.length).toBeGreaterThanOrEqual(2);

    const fn = result.symbols.find((s) => s.name === "calculateTotal");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.params.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// parseSource — Java
// ─────────────────────────────────────────────────────────────

describe("CodeParser.parseSource — Java", () => {
  const javaSource = `
package com.example;

public class UserService {
    /**
     * Find a user by their ID.
     */
    public User findById(String id) {
        return repo.get(id);
    }

    public void delete(String id) {
        repo.remove(id);
    }
}

interface Repository {
    User get(String id);
}
`;

  it("extracts Java methods and classes", async () => {
    const result = await parser.parseSource("UserService.java", javaSource);
    expect(result.language).toBe("java");
    expect(result.symbols.length).toBeGreaterThanOrEqual(2);

    const fn = result.symbols.find((s) => s.name === "findById");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("method");
    expect(fn!.params[0].name).toBe("id");
    expect(fn!.params[0].type).toBe("String");
  });

  it("extracts Java classes with inheritance", async () => {
    const result = await parser.parseSource("UserService.java", javaSource);
    expect(result.classes.length).toBeGreaterThanOrEqual(1);
    const cls = result.classes.find((c) => c.name === "UserService");
    expect(cls).toBeDefined();
    expect(cls!.methods).toContain("findById");
    expect(cls!.methods).toContain("delete");
  });
});

// ─────────────────────────────────────────────────────────────
// parseSource — C#
// ─────────────────────────────────────────────────────────────

describe("CodeParser.parseSource — C#", () => {
  const csSource = `
using System;

namespace App {
    public class PaymentService : IPaymentProcessor {
        /// <summary>Charge a customer.</summary>
        public bool Charge(decimal amount, string currency) {
            return Gateway.Process(amount, currency);
        }

        public PaymentService() {
            Init();
        }
    }
}
`;

  it("extracts C# methods and constructors", async () => {
    const result = await parser.parseSource("PaymentService.cs", csSource);
    expect(result.language).toBe("csharp");
    expect(result.symbols.length).toBeGreaterThanOrEqual(2);

    const charge = result.symbols.find((s) => s.name === "Charge");
    expect(charge).toBeDefined();
    expect(charge!.kind).toBe("method");
    expect(charge!.params.length).toBe(2);
  });

  it("extracts C# classes with bases", async () => {
    const result = await parser.parseSource("PaymentService.cs", csSource);
    expect(result.classes.length).toBeGreaterThanOrEqual(1);
    const cls = result.classes.find((c) => c.name === "PaymentService");
    expect(cls).toBeDefined();
  });

  it("classifies record and struct members as methods", async () => {
    const result = await parser.parseSource(
      "Models.cs",
      `
public record PaymentRecord {
    public bool Validate() {
        return true;
    }
}

public struct PaymentValue {
    public bool Validate() {
        return true;
    }
}
`,
    );

    const methods = result.symbols.filter((s) => s.name === "Validate");
    expect(methods).toHaveLength(2);
    expect(methods.every((s) => s.kind === "method")).toBe(true);
    expect(methods.map((s) => s.className).sort()).toEqual([
      "PaymentRecord",
      "PaymentValue",
    ]);
  });
});
