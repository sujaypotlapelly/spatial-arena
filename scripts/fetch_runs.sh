#!/usr/bin/env bash
# Fetch one data archive from the Spatial Arena release. RUNS_URL overrides its URL.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

case "${1:-}" in
  '')
    asset="ripple-runs-reach.tar.gz"
    expected="aa23c4deab2e6b610451304c83b33f6aa04e50fc1bcfc12df9e2aab20e7c5c8a"
    paths=(runs/reach)
    next='node sim/tools/reach_verify.mjs runs/reach/v3*'
    ;;
  --v4)
    asset="spatial-arena-v4.tar.gz"
    expected="8726b408ddfba0c3fdf30e459b41d02b41497fe42c487ea709caa20ccadb85b2"
    paths=(runs/v4-selection.json runs/v4test)
    next='node sim/tools/study/v4_report.mjs'
    ;;
  *) echo 'usage: scripts/fetch_runs.sh [--v4]' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo 'usage: scripts/fetch_runs.sh [--v4]' >&2; exit 2; }
url="${RUNS_URL:-https://github.com/sujaypotlapelly/spatial-arena/releases/download/runs-v1/$asset}"
[[ ! -L runs ]] || { echo "Refusing to install through a runs symlink" >&2; exit 1; }
mkdir -p runs
lock="runs/.fetch-$asset.lock"
mkdir "$lock" || { echo "Another download has reserved $lock" >&2; exit 1; }
trap 'rm -rf "$lock"' EXIT
curl -fL --retry 2 --progress-bar -o "$lock/archive" "$url"
if command -v sha256sum >/dev/null; then got="$(sha256sum "$lock/archive" | cut -d' ' -f1)"
else got="$(shasum -a 256 "$lock/archive" | cut -d' ' -f1)"; fi
[[ "$got" == "$expected" ]] || { echo "checksum mismatch for $asset" >&2; exit 1; }
tar -xzf "$lock/archive" -C "$lock"
# Preflight every collision before installing files. A retry can safely reuse
# identical files from an earlier download alongside the contributor's own runs.
python3 - "$lock" "${paths[@]}" <<'PYTHON'
import filecmp
import os
import sys
from pathlib import Path

stage = Path(sys.argv[1])
directories = []
files = []
for name in sys.argv[2:]:
    source = stage / name
    if not source.exists():
        sys.exit(f"Missing {name} in archive")
    for item in [source, *sorted(source.rglob("*"))]:
        dest = item.relative_to(stage)
        if dest.is_symlink() or any(parent.is_symlink() for parent in dest.parents):
            sys.exit(f"Refusing to install through a symlink: {dest}")
        if item.is_dir():
            if dest.exists() and not dest.is_dir():
                sys.exit(f"Directory conflicts with an existing file: {dest}")
            directories.append(dest)
        elif dest.exists():
            if not dest.is_file() or not filecmp.cmp(item, dest, shallow=False):
                sys.exit(f"Existing file differs from the archive: {dest}")
        else:
            files.append((item, dest))
for dest in directories:
    dest.mkdir(exist_ok=True)
for source, dest in files:
    os.link(source, dest)
PYTHON
echo "Installed $asset. Next: $next"
