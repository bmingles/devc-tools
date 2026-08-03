#!/usr/bin/env bash
# devc Feature — build-time install.
#
# Runtime-only staging: the heavy baseline (Claude CLI, .bashrc additions) lives
# in the bundled Dockerfile so it caches as reliable image layers and is shared
# with the zero-config path. This script only stages the runtime setup script
# that the Feature's postCreateCommand runs, so the Feature stays self-contained
# (usable on its own — e.g. once published to an OCI registry — without relying
# on devc's Dockerfile).
#
# Idempotent: safe to re-run on a rebuild.
set -euo pipefail

FEATURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -d -m 0755 /usr/local/share/devc
install -m 0755 "$FEATURE_DIR/post-create.sh" /usr/local/share/devc/post-create.sh
