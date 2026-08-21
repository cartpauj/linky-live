#!/usr/bin/env bash
# Build the installable add-on archive.
#
# Local names the installed folder after the archive filename, so the version is
# deliberately left out: every release then replaces the same folder instead of
# leaving old versions behind in the add-ons directory.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/dist"

mkdir -p "$out"
rm -f "$out"/*.tgz

cd "$root"
packed="$(npm pack --silent --pack-destination "$out")"
mv "$out/$packed" "$out/linky-live.tgz"

echo "Built dist/linky-live.tgz"
tar -tzf "$out/linky-live.tgz"
