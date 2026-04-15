#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const workspaceDir = process.argv[2] || path.resolve(__dirname, "..");
const configPath = path.join(workspaceDir, "nexus-config.yaml");

// ── Simple YAML parser ──
function parseServices(content) {
  const services = [];
  const lines = content.split("\n");
  let inServices = false,
    current = null;
  let inGit = false,
    inDatabases = false,
    inPipelines = false;

  for (const line of lines) {
    if (line.match(/^services:\s*$/)) {
      inServices = true;
      continue;
    }
    if (inServices && line.match(/^[a-z#]/) && !line.match(/^\s/)) {
      inServices = false;
    }
    if (!inServices) continue;

    if (line.match(/^\s{2}- name:\s*/)) {
      if (current) services.push(current);
      current = {
        name: line
          .replace(/^\s{2}- name:\s*/, "")
          .trim()
          .replace(/["']/g, ""),
        path: "",
        tech: "-",
        runtime: "-",
        description: "",
        ssh: "",
        default_branch: "master",
        databases: [],
        pipelines: [],
      };
      inGit = false;
      inDatabases = false;
      inPipelines = false;
      continue;
    }
    if (!current) continue;

    const trimmed = line.trimStart();

    if (trimmed.startsWith("path:")) {
      current.path = val(trimmed, "path:");
      inGit = false;
      inDatabases = false;
      inPipelines = false;
    } else if (trimmed.startsWith("tech:")) {
      current.tech = val(trimmed, "tech:");
      inGit = false;
      inDatabases = false;
      inPipelines = false;
    } else if (trimmed.startsWith("runtime:")) {
      current.runtime = val(trimmed, "runtime:");
    } else if (trimmed.startsWith("description:")) {
      current.description = val(trimmed, "description:");
    } else if (trimmed.startsWith("git:")) {
      inGit = true;
      inDatabases = false;
      inPipelines = false;
    } else if (inGit && trimmed.startsWith("ssh:")) {
      current.ssh = val(trimmed, "ssh:").replace(/#.*/, "").trim();
    } else if (inGit && trimmed.startsWith("remote:")) {
      current.ssh =
        current.ssh || val(trimmed, "remote:").replace(/#.*/, "").trim();
    } else if (inGit && trimmed.startsWith("default_branch:")) {
      current.default_branch = val(trimmed, "default_branch:");
    } else if (trimmed.startsWith("databases:")) {
      inDatabases = true;
      inGit = false;
      inPipelines = false;
    } else if (trimmed.startsWith("pipelines:")) {
      inPipelines = true;
      inGit = false;
      inDatabases = false;
    } else if (trimmed.startsWith("dependencies:")) {
      inGit = false;
      inDatabases = false;
      inPipelines = false;
    } else if (inDatabases && trimmed.startsWith("- ")) {
      current.databases.push(trimmed.slice(2).replace(/["']/g, ""));
    } else if (inPipelines && trimmed.startsWith("- ")) {
      current.pipelines.push(trimmed.slice(2).replace(/["']/g, ""));
    }
  }
  if (current) services.push(current);
  return services;
}

function val(line, key) {
  return line.replace(key, "").trim().replace(/["']/g, "");
}
function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

// ── Main ──
const content = fs.readFileSync(configPath, "utf8");
const services = parseServices(content);

if (!services.length) {
  console.log("\n  No services found in nexus-config.yaml\n");
  process.exit(0);
}

console.log("\n  Nexus Services\n");

let ok = 0,
  warn = 0,
  fail = 0;

services.forEach((svc, i) => {
  const svcPath = path.resolve(
    workspaceDir,
    svc.path || `./services/${svc.name}`,
  );
  const folderExists = fs.existsSync(svcPath);
  const gitExists = fs.existsSync(path.join(svcPath, ".git"));

  let status;
  if (!svc.ssh) {
    status = "No SSH URL";
    warn++;
  } else if (!folderExists) {
    status = "Not cloned";
    fail++;
  } else if (!gitExists) {
    status = "Not connected";
    warn++;
  } else {
    const remote = run("git remote get-url origin", svcPath);
    if (remote === svc.ssh) {
      status = "Connected";
      ok++;
    } else {
      status = "Not connected";
      warn++;
    }
  }

  let branch = "-",
    lastCommit = "-";
  if (gitExists) {
    branch = run("git branch --show-current", svcPath) || "-";
    lastCommit = run("git log --oneline -1", svcPath) || "-";
    if (lastCommit.length > 60) lastCommit = lastCommit.slice(0, 60) + "...";
  }

  console.log(`  ${i + 1}. ${svc.name}`);
  console.log(`     Tech: ${svc.tech}`);
  console.log(`     Status: ${status}`);
  if (svc.ssh) console.log(`     Git: ${svc.ssh}`);
  console.log(`     Branch: ${branch}`);
  console.log(`     Commit: ${lastCommit}`);
  if (svc.databases.length) console.log(`     DB: ${svc.databases.join(", ")}`);
  console.log("");
});

console.log(
  `  Total: ${services.length}  |  Connected: ${ok}  |  Warning: ${warn}  |  Error: ${fail}\n`,
);
