#!/bin/bash
set -e

cd client && deno task build && sudo mv devc-host /usr/local/bin/devc-host