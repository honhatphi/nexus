#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-services.sh — Thiết lập git repo cho từng service trong nexus-config.yaml
#
# Mỗi service trong /services/* là 1 git repo độc lập (GitLab) — KHÔNG thuộc
# Nexus GitHub repo. Script này đọc nexus-config.yaml, tìm service có khai báo
# git.ssh và init/clone nó.
#
# Usage:
#   bash scripts/setup-services.sh               # setup all services
#   bash scripts/setup-services.sh warehouse-2.0 # setup 1 service cụ thể
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$WORKSPACE_DIR/nexus-config.yaml"
TARGET_SERVICE="${1:-}"

echo "🏗️  Nexus Service Setup"
echo "   Config: $CONFIG_FILE"
echo "   Target: ${TARGET_SERVICE:-all services}"
echo ""

node - "$CONFIG_FILE" "$TARGET_SERVICE" "$WORKSPACE_DIR" << 'NODEJS'
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const configPath = process.argv[2];
const target = process.argv[3] || '';
const workspaceDir = process.argv[4];

// ── Simple YAML parser ──
function parseServices(content) {
  const services = [];
  const lines = content.split('\n');
  let inServices = false, current = null, inGit = false;

  for (const line of lines) {
    if (line.match(/^services:\s*$/)) { inServices = true; continue; }
    if (inServices && line.match(/^[a-z#]/) && !line.match(/^\s/)) { inServices = false; }
    if (!inServices) continue;

    if (line.match(/^\s{2}- name:\s*/)) {
      if (current) services.push(current);
      current = {
        name: line.replace(/^\s{2}- name:\s*/, '').trim().replace(/["']/g, ''),
        path: '', ssh: '', default_branch: 'master'
      };
      inGit = false;
      continue;
    }
    if (!current) continue;

    const trimmed = line.trimStart();
    if (trimmed.startsWith('path:')) { current.path = trimmed.replace('path:', '').trim().replace(/["']/g, ''); inGit = false; }
    else if (trimmed.startsWith('git:')) { inGit = true; }
    else if (inGit && trimmed.startsWith('ssh:')) { current.ssh = trimmed.replace('ssh:', '').trim().replace(/["']/g, '').replace(/#.*/, '').trim(); }
    else if (inGit && trimmed.startsWith('remote:')) { current.ssh = current.ssh || trimmed.replace('remote:', '').trim().replace(/["']/g, '').replace(/#.*/, '').trim(); }
    else if (inGit && trimmed.startsWith('default_branch:')) { current.default_branch = trimmed.replace('default_branch:', '').trim().replace(/["']/g, ''); }
    else if (trimmed.match(/^\w/) && !trimmed.startsWith('-')) { inGit = false; }
  }
  if (current) services.push(current);
  return services;
}

function run(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return e.stderr || e.message; }
}

const content = fs.readFileSync(configPath, 'utf8');
const services = parseServices(content);

for (const svc of services) {
  if (target && svc.name !== target) continue;

  const remote = svc.ssh;
  const defaultBranch = svc.default_branch;
  const svcPath = path.resolve(workspaceDir, svc.path || `./services/${svc.name}`);

  console.log(`━━━ Service: ${svc.name} ━━━`);
  console.log(`    Path   : ${svcPath}`);
  console.log(`    Remote : ${remote || '(chưa khai báo)'}`);

  if (!remote) {
    console.log(`    ⚠️  Bỏ qua — chưa khai báo git.ssh trong nexus-config.yaml\n`);
    continue;
  }

  fs.mkdirSync(svcPath, { recursive: true });
  const gitDir = path.join(svcPath, '.git');

  if (fs.existsSync(gitDir)) {
    // Repo đã tồn tại → kiểm tra remote
    const currentRemote = run('git remote get-url origin', svcPath);
    if (currentRemote === remote) {
      console.log(`    ✅ Repo đã setup đúng, fetch latest...`);
      run('git fetch origin', svcPath);
    } else {
      console.log(`    ⚠️  Remote khác (${currentRemote}), cập nhật...`);
      run(`git remote set-url origin ${remote}`, svcPath);
      run('git fetch origin', svcPath);
    }
  } else {
    // Thư mục có code nhưng chưa có .git → init + link remote
    const hasFiles = fs.readdirSync(svcPath).length > 0;
    if (hasFiles) {
      console.log(`    📁 Thư mục đã có code, init git + link remote...`);
      run('git init', svcPath);
      run(`git remote add origin ${remote}`, svcPath);
      console.log(`    Fetching from remote...`);
      run('git fetch origin', svcPath);
      // Set tracking if remote branch exists
      const branches = run('git branch -r', svcPath);
      if (branches.includes(`origin/${defaultBranch}`)) {
        run(`git branch --set-upstream-to=origin/${defaultBranch} ${defaultBranch}`, svcPath);
      }
    } else {
      console.log(`    📥 Clone từ remote...`);
      run(`git clone ${remote} ${svcPath}`, workspaceDir);
    }
  }

  console.log(`    ✅ Done\n`);
}

console.log('🎉 Setup hoàn tất!');
NODEJS
