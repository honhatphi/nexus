#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# service-status.sh — Hiển thị trạng thái kết nối của tất cả services
#
# Usage:
#   bash scripts/service-status.sh          # report tất cả
#   bash scripts/service-status.sh -v       # verbose (thêm branch, last commit)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$WORKSPACE_DIR/nexus-config.yaml"
VERBOSE="${1:-}"

node - "$CONFIG_FILE" "$VERBOSE" "$WORKSPACE_DIR" << 'NODEJS'
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const configPath = process.argv[2];
const verbose = process.argv[3] === '-v';
const workspaceDir = process.argv[4];

// ── Simple YAML parser for nexus-config.yaml ──
function parseServices(content) {
  const services = [];
  const lines = content.split('\n');
  let inServices = false;
  let current = null;
  let inGit = false;
  let inDatabases = false;
  let inPipelines = false;

  for (const line of lines) {
    if (line.match(/^services:\s*$/)) { inServices = true; continue; }
    if (inServices && line.match(/^[a-z#]/) && !line.match(/^\s/)) { inServices = false; }
    if (!inServices) continue;

    // New service entry
    if (line.match(/^\s{2}- name:\s*/)) {
      if (current) services.push(current);
      current = {
        name: line.replace(/^\s{2}- name:\s*/, '').trim().replace(/["']/g, ''),
        path: '', tech: '-', runtime: '-', description: '',
        ssh: '', default_branch: 'master',
        databases: [], pipelines: [], dependencies: []
      };
      inGit = false; inDatabases = false; inPipelines = false;
      continue;
    }
    if (!current) continue;

    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (trimmed.startsWith('path:')) { current.path = trimmed.replace('path:', '').trim().replace(/["']/g, ''); inGit = false; inDatabases = false; inPipelines = false; }
    else if (trimmed.startsWith('tech:')) { current.tech = trimmed.replace('tech:', '').trim().replace(/["']/g, ''); inGit = false; inDatabases = false; inPipelines = false; }
    else if (trimmed.startsWith('runtime:')) { current.runtime = trimmed.replace('runtime:', '').trim().replace(/["']/g, ''); }
    else if (trimmed.startsWith('description:')) { current.description = trimmed.replace('description:', '').trim().replace(/["']/g, ''); }
    else if (trimmed.startsWith('git:')) { inGit = true; inDatabases = false; inPipelines = false; }
    else if (inGit && trimmed.startsWith('ssh:')) { current.ssh = trimmed.replace('ssh:', '').trim().replace(/["']/g, '').replace(/#.*/, '').trim(); }
    else if (inGit && trimmed.startsWith('remote:')) { current.ssh = current.ssh || trimmed.replace('remote:', '').trim().replace(/["']/g, '').replace(/#.*/, '').trim(); }
    else if (inGit && trimmed.startsWith('default_branch:')) { current.default_branch = trimmed.replace('default_branch:', '').trim().replace(/["']/g, ''); }
    else if (trimmed.startsWith('databases:')) { inDatabases = true; inGit = false; inPipelines = false; }
    else if (trimmed.startsWith('pipelines:')) { inPipelines = true; inGit = false; inDatabases = false; }
    else if (trimmed.startsWith('dependencies:')) { inGit = false; inDatabases = false; inPipelines = false; }
    else if (inDatabases && trimmed.startsWith('- ')) { current.databases.push(trimmed.slice(2).replace(/["']/g, '')); }
    else if (inPipelines && trimmed.startsWith('- ')) { current.pipelines.push(trimmed.slice(2).replace(/["']/g, '')); }
  }
  if (current) services.push(current);
  return services;
}

function run(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { return ''; }
}

// ── Parse config ──
const content = fs.readFileSync(configPath, 'utf8');
const services = parseServices(content);

if (!services.length) {
  console.log('⚠️  Không có service nào trong nexus-config.yaml');
  process.exit(0);
}

// ── Header ──
console.log('');
console.log('╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║                    📊 Nexus Services Status Report                      ║');
console.log('╚══════════════════════════════════════════════════════════════════════════╝');
console.log('');

// ── Collect status ──
let total = services.length, connected = 0, warnings = 0, missing = 0;
const rows = [];

for (const svc of services) {
  const svcPath = path.resolve(workspaceDir, svc.path || `./services/${svc.name}`);
  const folderExists = fs.existsSync(svcPath);
  const gitExists = fs.existsSync(path.join(svcPath, '.git'));

  let status, statusIcon;
  if (!svc.ssh) {
    status = 'no SSH URL'; statusIcon = '⚠️ '; warnings++;
  } else if (!folderExists) {
    status = 'folder missing'; statusIcon = '❌'; missing++;
  } else if (!gitExists) {
    status = 'no .git init'; statusIcon = '📁'; warnings++;
  } else {
    const currentRemote = run('git remote get-url origin', svcPath);
    if (currentRemote === svc.ssh) {
      status = 'connected'; statusIcon = '✅'; connected++;
    } else if (currentRemote) {
      status = 'remote mismatch'; statusIcon = '⚠️ '; warnings++;
    } else {
      status = 'no remote'; statusIcon = '⚠️ '; warnings++;
    }
  }

  let branch = '-', lastCommit = '-';
  if (verbose && gitExists) {
    branch = run('git branch --show-current', svcPath) || '-';
    lastCommit = run('git log --oneline -1', svcPath) || '-';
    if (lastCommit.length > 45) lastCommit = lastCommit.slice(0, 45) + '...';
  }

  rows.push({ ...svc, status, statusIcon, branch, lastCommit });
}

// ── Print table ──
const nameW = Math.max(9, ...rows.map(r => r.name.length));
const techW = Math.max(4, ...rows.map(r => r.tech.length));
const statusW = Math.max(6, ...rows.map(r => (r.statusIcon + ' ' + r.status).length));

if (verbose) {
  const branchW = Math.max(6, ...rows.map(r => r.branch.length));
  console.log(`  ${'Service'.padEnd(nameW)}  ${'Tech'.padEnd(techW)}  ${'Status'.padEnd(statusW)}  ${'Branch'.padEnd(branchW)}  Last Commit`);
  console.log(`  ${'─'.repeat(nameW)}  ${'─'.repeat(techW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(branchW)}  ${'─'.repeat(40)}`);
  for (const r of rows) {
    const st = `${r.statusIcon} ${r.status}`;
    console.log(`  ${r.name.padEnd(nameW)}  ${r.tech.padEnd(techW)}  ${st.padEnd(statusW)}  ${r.branch.padEnd(branchW)}  ${r.lastCommit}`);
  }
} else {
  console.log(`  ${'Service'.padEnd(nameW)}  ${'Tech'.padEnd(techW)}  ${'Status'.padEnd(statusW)}  SSH URL`);
  console.log(`  ${'─'.repeat(nameW)}  ${'─'.repeat(techW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(45)}`);
  for (const r of rows) {
    const st = `${r.statusIcon} ${r.status}`;
    const sshDisplay = r.ssh ? (r.ssh.length > 50 ? r.ssh.slice(0, 50) + '...' : r.ssh) : '(chưa khai báo)';
    console.log(`  ${r.name.padEnd(nameW)}  ${r.tech.padEnd(techW)}  ${st.padEnd(statusW)}  ${sshDisplay}`);
  }
}

// ── Summary ──
console.log('');
console.log('  ╭─────────────────────────────────────────────╮');
console.log(`  │  Total: ${total}   ✅ ${connected}   ⚠️  ${warnings}   ❌ ${missing}`.padEnd(47) + '│');
console.log('  ╰─────────────────────────────────────────────╯');
console.log('');
NODEJS
