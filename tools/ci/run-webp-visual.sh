#!/usr/bin/env bash
set -euo pipefail

test "$(uname -sm)" = "Linux x86_64"
test "$(node -p 'process.version + "/" + process.arch')" = "v22.23.2/x64"
source_root="$(pwd -P)"
node_executable="$(realpath "$(command -v node)")"
output="$(realpath "$1")"
temp="$(mktemp -d "${RUNNER_TEMP:?}/tfsb-webp.XXXXXXXX")"
mkdir "$temp/encoder" "$temp/result"

lock="tools/ci/webp-encoder-lock.json"
lock_hash="3f6a981de846323c1e802a2448029eb65dfe8663d0481447352653135c42aaed"
printf '%s  %s\n' "$lock_hash" "$lock" | sha256sum -c -
encoder="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["root"])' "$lock")"
intake_image="nixos/nix@sha256:617d914dba5384bf75adf17081583b69371031ec7defce36c34c5fa14fc819b0"
browser_image="mcr.microsoft.com/playwright@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac"

docker pull --platform linux/amd64 "$intake_image"
docker pull --platform linux/amd64 "$browser_image"
docker run --rm --pull=never --platform linux/amd64 \
  --mount "type=bind,source=$temp/encoder,target=/closure" \
  "$intake_image" /bin/sh -eu -c '
    store="local?root=/closure"
    nix --extra-experimental-features nix-command --option require-sigs true copy \
      --from https://cache.nixos.org --to "$store" "$1" >&2
    nix --extra-experimental-features nix-command --store "$store" store verify \
      --recursive --sigs-needed 1 "$1" >&2
    nix --extra-experimental-features nix-command --store "$store" path-info --recursive --json "$1"
  ' sh "$encoder" > "$temp/path-info.json"
python3 tools/ci/webp-encoder-lock.py check "$temp/path-info.json" "$lock"
cp "$lock" "$output/encoder-closure.json"

docker run --rm --pull=never --platform linux/amd64 --network none --read-only \
  --user "$(id -u):$(id -g)" \
  --shm-size 1g --tmpfs /tmp:rw,nosuid,mode=1777,size=1g --workdir /workspace \
  --env "PATH=/opt/pinned-node:$encoder/bin:/usr/local/bin:/usr/bin:/bin" \
  --env HOME=/tmp --env PLAYWRIGHT_JSON_OUTPUT_FILE=/result/report.json \
  --mount "type=bind,source=$node_executable,target=/opt/pinned-node/node,readonly" \
  --mount "type=bind,source=$source_root,target=/workspace,readonly" \
  --mount "type=bind,source=$temp/encoder/nix/store,target=/nix/store,readonly" \
  --mount "type=bind,source=$temp/result,target=/result" \
  "$browser_image" /bin/sh -eu -c '
    test "$(node -p '"'"'process.version + "/" + process.arch'"'"')" = "v22.23.2/x64"
    node node_modules/@playwright/test/cli.js test \
      --config playwright.illustration.config.ts --workers 1 --reporter=json --output /result/fixtures
  '
python3 tools/ci/webp-visual-proof.py "$temp/result" "$output/webp-proof.json"
