#!/bin/bash
# `devcontainer features test` scenario — runs INSIDE a container built from this Feature.
#
# It exists to pin two pieces of *undocumented* devcontainer CLI behavior that this Feature
# silently depends on. The published Feature schema allows object mounts only, so neither of
# these is guaranteed by anything but observation:
#
#   1. `${localEnv:HOME}` is substituted in a Feature-declared mount source.
#   2. A mount written as a *string* is passed through to Docker verbatim, so `readonly`
#      survives. (The object form is re-serialized through the CLI's `Mount` interface,
#      which has no `readonly` field.)
#
# Without this, a CLI upgrade that stops doing either surfaces as a mysteriously writable
# mount in somebody's container instead of as a failing test here.
#
# Precondition: the HOST must have the bridge installed, i.e. `~/.config/devc-bridge/run`
# holding a `token` and `~/.config/devc-bridge/client` holding the Linux client. That is the
# same prerequisite this Feature puts on real users — see the README.
set -e

source dev-container-features-test-lib

# Finding 1. An *unsubstituted* source (a literal `${localEnv:HOME}/...` path) could not
# produce a populated mount, so content here is the proof that substitution happened.
check "token mount is populated" test -f /run/devc-bridge/token
check "client mount is populated" \
  test -x /usr/local/share/devc-bridge/client/devc-bridge

# Finding 2. `sudo`, deliberately: as the non-root remote user a failed write would only
# prove the directory is not ours. Failing as root is what proves the mount is read-only.
check "run/ is read-only" bash -c '! sudo touch /run/devc-bridge/probe'
check "client/ is read-only" \
  bash -c '! sudo touch /usr/local/share/devc-bridge/client/probe'

# install.sh's PATH symlink, made at image build time — before either mount existed.
check "devc-bridge is on PATH" bash -c 'command -v devc-bridge'
check "and is a symlink to the mounted client" bash -c \
  '[ "$(readlink /usr/local/bin/devc-bridge)" = /usr/local/share/devc-bridge/client/devc-bridge ]'

# Not asserted here: `devc-bridge ping test` → `pong`. That needs the host bridge *running*,
# not merely installed, which is a live-host check rather than a container one.

reportResults
