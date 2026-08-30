#!/bin/bash
# Scenario `with_herdr_plugins` — installHerdr: true plus one herdrPlugins entry. Exercises the
# build-time `herdr plugin install <entry> --yes` path: the plugin must be registered and
# visible to `herdr plugin list`, since plugin registration is global to the user (not per
# session) and ~/.config/herdr is not a mount — this is the only way it survives a rebuild.
set -e

source dev-container-features-test-lib

check "herdr is on PATH" bash -c "command -v herdr"

check "the plugin appears in herdr plugin list" bash -c \
  "herdr plugin list | grep -qF 'agent-caffeinate'"

reportResults
