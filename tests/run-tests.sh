#!/bin/sh
# Runs all TailMic tests in Docker (nothing is installed on your computer).
#   sh tests/run-tests.sh
# Only some end-to-end tests (part of a test's name):
#   ONLY='messages keep up' sh tests/run-tests.sh
set -e
cd "$(dirname "$0")/.."
echo "== unit tests (Node 22)"
docker run --rm -v "$PWD":/w:ro -w /w node:22-alpine node --test 'tests/unit/*.test.js'
echo "== script checks (PowerShell 7)"
docker run --rm -v "$PWD":/w:ro -w /w mcr.microsoft.com/powershell:lts-alpine-3.20 pwsh -NoProfile -File tests/ps/helpers.test.ps1
echo "== end-to-end test (two headless Chromium browsers, fake microphone)"
docker run --rm --ipc=host -v "$PWD":/w:ro -e TAILMIC_ROOT=/w -e ONLY mcr.microsoft.com/playwright:v1.49.1-noble \
  bash -c 'mkdir -p /tmp/e2e && cd /tmp/e2e && npm init -y >/dev/null && npm i --silent playwright@1.49.1 >/dev/null 2>&1 && cp /w/tests/e2e/e2e.mjs . && node e2e.mjs'
