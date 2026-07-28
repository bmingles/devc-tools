# devc-tools shell integration.
#
# Source this from your ~/.bashrc (or ~/.bash_aliases):
#   source /path/to/devc-tools/scripts/bash_aliases.sh
#
# It defines a `devc-tools` shell function that runs the host-side command-bridge
# control CLI straight from source via Deno — no compile step:
#   devc-tools start | stop | status | restart
#
# Requires Deno 2.9+ on PATH. The tray itself needs `deno desktop` (macOS GUI); the
# first `start` builds the app bundle, so it can take ~10-30s (see the notice it prints).

# Resolve <repo>/host/main.ts relative to THIS file, at source time, so the function
# works regardless of the caller's cwd. Guarded so a bad path fails loudly, not silently.
if _devc_tools_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../host" 2>/dev/null && pwd)"; then
  export DEVC_TOOLS_MAIN="$_devc_tools_dir/main.ts"
  unset _devc_tools_dir
else
  echo "devc-tools: could not locate host/main.ts next to ${BASH_SOURCE[0]:-$0}" >&2
fi

devc-tools() {
  if [ -z "${DEVC_TOOLS_MAIN:-}" ] || [ ! -f "$DEVC_TOOLS_MAIN" ]; then
    echo "devc-tools: DEVC_TOOLS_MAIN not set or missing; re-source scripts/bash_aliases.sh" >&2
    return 1
  fi
  deno run \
    --allow-read --allow-write --allow-run --allow-env --allow-net \
    "$DEVC_TOOLS_MAIN" "$@"
}
