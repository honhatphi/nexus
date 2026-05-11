#!/usr/bin/env node
/**
 * migrate-mcp-api.mjs
 * Migrates deprecated server.tool() → server.registerTool()
 *                    server.resource() → server.registerResource()
 *
 * Transformation:
 *   server.tool("name", "description", { schema }, cb)
 *   → server.registerTool("name", { description: "description", inputSchema: { schema } }, cb)
 *
 *   server.tool("name", "description", cb)  [no schema — rare]
 *   → server.registerTool("name", { description: "description" }, cb)
 *
 *   server.resource(...) → server.registerResource(...)
 *   [resource() has same arg shape as registerResource() — just rename]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../mcp-server/src",
);

// ── Utility: extract balanced content between start and a matching bracket ──
function extractBalanced(src, start, open, close) {
  let depth = 0;
  let i = start;
  let content = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        content += ch;
        return { content, end: i };
      }
    }
    content += ch;
    i++;
  }
  return null; // unbalanced
}

// ── Extract a JS string literal starting at `i` ─────────────────────────────
function extractString(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let j = i + 1;
  let content = q;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      content += ch + src[j + 1];
      j += 2;
      continue;
    }
    content += ch;
    j++;
    if (ch === q) break;
  }
  return { content, end: j - 1 };
}

// ── Skip whitespace/newlines ─────────────────────────────────────────────────
function skipWS(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

// ── Transform server.tool(…) calls in source ────────────────────────────────
function transformServerTool(src) {
  let result = "";
  let i = 0;

  while (i < src.length) {
    // Match "server.tool("
    const marker = "server.tool(";
    const idx = src.indexOf(marker, i);
    if (idx === -1) {
      result += src.slice(i);
      break;
    }

    result += src.slice(i, idx);
    i = idx + marker.length; // position after "server.tool("

    // ── Parse arg 1: name (string) ──
    const nameStart = skipWS(src, i);
    const nameResult = extractString(src, nameStart);
    if (!nameResult) {
      // Cannot parse — emit as-is and continue
      result += marker;
      continue;
    }
    const nameStr = nameResult.content; // e.g. '"nexus_open_task"'
    i = nameResult.end + 1;

    // Skip comma
    i = skipWS(src, i);
    if (src[i] !== ",") {
      result += marker + nameStr;
      continue;
    }
    i++; // skip comma

    // ── Parse arg 2: description string OR schema/callback ──
    i = skipWS(src, i);
    const q = src[i];

    let descStr = null;
    let schemaStr = null;
    let cbStart = i;

    if (q === '"' || q === "'" || q === "`") {
      // arg2 is description string
      const descResult = extractString(src, i);
      if (!descResult) {
        result += marker + nameStr + ", ";
        continue;
      }
      descStr = descResult.content;
      i = descResult.end + 1;

      // Skip comma
      i = skipWS(src, i);
      if (src[i] !== ",") {
        result += marker + nameStr + ", " + descStr;
        continue;
      }
      i++;

      // ── Parse arg 3: schema object OR callback ──
      i = skipWS(src, i);

      if (src[i] === "{") {
        // schema object
        const schemaResult = extractBalanced(src, i, "{", "}");
        if (!schemaResult) {
          result += marker + nameStr + ", " + descStr + ", ";
          continue;
        }
        schemaStr = schemaResult.content;
        i = schemaResult.end + 1;

        // Skip comma
        i = skipWS(src, i);
        if (src[i] !== ",") {
          result += `server.registerTool(${nameStr}, { description: ${descStr}, inputSchema: ${schemaStr} })`;
          continue;
        }
        i++;

        // ── Parse arg 4: callback ──
        cbStart = skipWS(src, i);
      } else {
        // No schema — arg3 is callback
        cbStart = i;
        schemaStr = null;
      }
    } else {
      // No description string — arg2 might be schema or callback
      // (zero-arg tool or schema-only)
      if (src[i] === "{") {
        // schema without description
        const schemaResult = extractBalanced(src, i, "{", "}");
        if (!schemaResult) {
          result += marker + nameStr + ", ";
          continue;
        }
        schemaStr = schemaResult.content;
        i = schemaResult.end + 1;

        i = skipWS(src, i);
        if (src[i] !== ",") {
          result += `server.registerTool(${nameStr}, { inputSchema: ${schemaStr} })`;
          continue;
        }
        i++;
        cbStart = skipWS(src, i);
      } else {
        // callback directly (zero-arg)
        cbStart = i;
      }
    }

    // ── Extract callback — depth-track from cbStart to matching ")" of server.tool( ──
    // Use SEPARATE counters for (), {}, [] to avoid cross-bracket mismatches.
    let parenDepth = 1; // The "(" of server.tool( is already consumed
    let braceDepth = 0;
    let bracketDepth = 0;
    let j = cbStart;
    while (j < src.length) {
      // Skip strings
      const ch = src[j];
      if (ch === '"' || ch === "'" || ch === "`") {
        const sRes = extractString(src, j);
        if (sRes) {
          j = sRes.end + 1;
          continue;
        }
      }
      // Skip line comments
      if (ch === "/" && src[j + 1] === "/") {
        while (j < src.length && src[j] !== "\n") j++;
        continue;
      }
      // Skip block comments
      if (ch === "/" && src[j + 1] === "*") {
        j += 2;
        while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
        j += 2;
        continue;
      }

      if (ch === "(") parenDepth++;
      else if (ch === ")") {
        parenDepth--;
        if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) break;
      } else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;

      j++;
    }

    // j is now at the closing ")" of server.tool(...)
    const cbContent = src.slice(cbStart, j).trimEnd();
    // Remove trailing comma if present (last arg before closing paren)
    const cbClean = cbContent.endsWith(",")
      ? cbContent.slice(0, -1).trimEnd()
      : cbContent;

    // ── Emit new API call ──
    if (descStr && schemaStr) {
      result += `server.registerTool(${nameStr}, {\n    description: ${descStr},\n    inputSchema: ${schemaStr},\n  }, ${cbClean})`;
    } else if (descStr) {
      result += `server.registerTool(${nameStr}, { description: ${descStr} }, ${cbClean})`;
    } else if (schemaStr) {
      result += `server.registerTool(${nameStr}, { inputSchema: ${schemaStr} }, ${cbClean})`;
    } else {
      result += `server.registerTool(${nameStr}, {}, ${cbClean})`;
    }

    i = j + 1; // skip the closing ")"
  }

  return result;
}

// ── Transform server.resource() — just rename ───────────────────────────────
function transformServerResource(src) {
  return src.replace(/server\.resource\(/g, "server.registerResource(");
}

// ── Process a single file ────────────────────────────────────────────────────
function processFile(filePath) {
  let src = fs.readFileSync(filePath, "utf8");
  const original = src;

  if (src.includes("server.tool(")) {
    src = transformServerTool(src);
  }
  if (src.includes("server.resource(")) {
    src = transformServerResource(src);
  }

  if (src !== original) {
    fs.writeFileSync(filePath, src, "utf8");
    return true;
  }
  return false;
}

// ── Walk directory ───────────────────────────────────────────────────────────
function walkTs(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") {
      files.push(...walkTs(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const files = walkTs(ROOT);
let changed = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const wasChanged = processFile(f);
  if (wasChanged) {
    changed++;
    console.log(`  ✓ migrated  ${rel}`);
  }
}
console.log(`\nDone — ${changed} file(s) updated.`);
