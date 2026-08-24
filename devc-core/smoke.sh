#!/bin/bash
# Builds, packs, and drives the real tarball from a scratch npm project with plain `node` — no
# Deno, no `devcontainer`, no `devc` anywhere on PATH. See smoke.mjs and the Validation section
# of .plans/devc-core-npm-library.md ("npm pack the library ... Node only").
#
#   npm run smoke        (from devc-core/, after `npm install` — or npm ci in CI)
set -euo pipefail
cd "$(dirname "$0")"

npm run build
npm pack --pack-destination /tmp

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch" /tmp/devc-tools-core-*.tgz' EXIT

(cd "$scratch" && npm init -y >/dev/null && npm install /tmp/devc-tools-core-*.tgz)
cp smoke.mjs "$scratch/"

# No Deno, no `devcontainer`, no `devc` — only node itself and the coreutils smoke.mjs's temp-dir
# plumbing needs.
env -i HOME="$HOME" PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" \
  node "$scratch/smoke.mjs"
