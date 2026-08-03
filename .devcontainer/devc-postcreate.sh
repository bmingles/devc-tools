#!/bin/bash
set -e

cd devc-bridge/client && deno task build && sudo mv devc-bridge /usr/local/bin/devc-bridge
