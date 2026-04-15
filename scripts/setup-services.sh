#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-services.sh — Thiết lập git repo cho từng service trong nexus-config.yaml
#
# Mỗi service trong /services/* là 1 git repo độc lập (GitLab) — KHÔNG thuộc
# Nexus GitHub repo. Script này đọc nexus-config.yaml, tìm service có khai báo
# git.remote và init/clone nó.
#
# Usage:
#   bash scripts/setup-services.sh               # setup all services
#   bash scripts/setup-services.sh warehouse-2.0 # setup 1 service cụ thể
#
# Requirements: git, python3 (để parse YAML đơn giản)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$WORKSPACE_DIR/nexus-config.yaml"
TARGET_SERVICE="${1:-}"

echo "🏗️  Nexus Service Setup"
echo "   Config: $CONFIG_FILE"
echo "   Target: ${TARGET_SERVICE:-all services}"
echo ""

# Parse nexus-config.yaml và setup từng service có khai báo git.remote
python3 - "$CONFIG_FILE" "$TARGET_SERVICE" << 'PYEOF'
import sys
import os
import subprocess

config_path = sys.argv[1]
target = sys.argv[2] if len(sys.argv) > 2 else ""

# Parse YAML thủ công cho cấu trúc đơn giản (không cần PyYAML)
try:
    import yaml
    with open(config_path) as f:
        config = yaml.safe_load(f)
except ImportError:
    # Fallback: dùng re để parse
    import re
    print("⚠️  PyYAML không có, dùng parser đơn giản")
    config = None

if config is None:
    print("❌ Không parse được nexus-config.yaml. Cài: pip install pyyaml")
    sys.exit(1)

services = config.get("services", [])
workspace_dir = os.path.dirname(os.path.abspath(config_path))

for svc in services:
    name = svc.get("name", "")
    if target and name != target:
        continue

    git_cfg = svc.get("git", {})
    remote = (git_cfg.get("ssh") or git_cfg.get("remote") or "").strip()
    default_branch = git_cfg.get("default_branch", "master")
    svc_path = os.path.join(workspace_dir, svc.get("path", f"./services/{name}"))

    print(f"━━━ Service: {name} ━━━")
    print(f"    Path   : {svc_path}")
    print(f"    Remote : {remote or '(chưa khai báo)'}")

    if not remote:
        print(f"    ⚠️  Bỏ qua — chưa khai báo git.ssh trong nexus-config.yaml\n")
        continue

    os.makedirs(svc_path, exist_ok=True)
    git_dir = os.path.join(svc_path, ".git")

    if os.path.exists(git_dir):
        # Repo đã tồn tại → kiểm tra remote
        result = subprocess.run(
            ["git", "-C", svc_path, "remote", "get-url", "origin"],
            capture_output=True, text=True
        )
        current_remote = result.stdout.strip()
        if current_remote == remote:
            print(f"    ✅ Repo đã setup đúng, fetch latest...")
            subprocess.run(["git", "-C", svc_path, "fetch", "origin"], check=False)
        else:
            print(f"    ⚠️  Remote khác ({current_remote}), cập nhật...")
            subprocess.run(["git", "-C", svc_path, "remote", "set-url", "origin", remote], check=True)
            subprocess.run(["git", "-C", svc_path, "fetch", "origin"], check=False)
    else:
        # Thư mục có code nhưng chưa có .git → init + link remote
        has_files = any(os.scandir(svc_path))
        if has_files:
            print(f"    📁 Thư mục đã có code, init git + link remote...")
            subprocess.run(["git", "-C", svc_path, "init"], check=True)
            subprocess.run(["git", "-C", svc_path, "remote", "add", "origin", remote], check=True)
            subprocess.run(["git", "-C", svc_path, "fetch", "origin"], check=False)
            # Nếu có remote branch → set tracking
            result = subprocess.run(
                ["git", "-C", svc_path, "branch", "-r"],
                capture_output=True, text=True
            )
            if f"origin/{default_branch}" in result.stdout:
                subprocess.run(
                    ["git", "-C", svc_path, "branch", "--set-upstream-to",
                     f"origin/{default_branch}", default_branch],
                    check=False
                )
        else:
            print(f"    📥 Clone từ remote...")
            subprocess.run(["git", "clone", remote, svc_path], check=True)

    print(f"    ✅ Done\n")

print("🎉 Setup hoàn tất!")
PYEOF
