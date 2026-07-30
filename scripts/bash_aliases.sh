# devc-tools shell integration — one shell function per tool in this repo.
#
# Source this from your ~/.bashrc (or ~/.bash_aliases):
#   source /path/to/devc-tools/scripts/bash_aliases.sh
#
# Each function runs its tool straight from source via Deno — no compile step:
#   devc-bridge start | stop | status | restart
#   devc-tui list | status | select <id> | deselect <id> | apply | skills | config
#
# Requires Deno 2.9+ on PATH. devc-bridge's tray also needs `deno desktop` (macOS GUI);
# its `start` builds the app bundle, so the first one takes ~10-30s (it says so).

# Resolve the repo root from THIS file, at source time, so the functions work regardless
# of the caller's cwd. Guarded so a bad path fails loudly, not silently.
if _devc_tools_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"; then
  export DEVC_TOOLS_ROOT="$_devc_tools_root"
  export DEVC_BRIDGE_MAIN="$DEVC_TOOLS_ROOT/devc-bridge/host/main.ts"
  export DEVC_TUI_MAIN="$DEVC_TOOLS_ROOT/devc-tui/main.ts"
  unset _devc_tools_root
else
  echo "devc-tools: could not locate the repo root above ${BASH_SOURCE[0]:-$0}" >&2
fi

# Run one tool's entrypoint from source. $1 = tool name (for errors), $2 = entrypoint.
_devc_tools_run() {
  local name="$1" main="$2"
  shift 2
  if [ -z "$main" ] || [ ! -f "$main" ]; then
    echo "$name: entrypoint not found ($main); re-source scripts/bash_aliases.sh" >&2
    return 1
  fi
  deno run \
    --allow-read --allow-write --allow-run --allow-env --allow-net \
    "$main" "$@"
}

devc-bridge() { _devc_tools_run devc-bridge "${DEVC_BRIDGE_MAIN:-}" "$@"; }

# devc-tui edits the devcontainer.json / .code-workspace of whatever repo you run it in,
# so run it from that repo (it uses the cwd as the workspace dir unless --workspace-dir).
devc-tui() { _devc_tools_run devc-tui "${DEVC_TUI_MAIN:-}" "$@"; }

# Adding a tool: export its <TOOL>_MAIN above, then one function line here.
