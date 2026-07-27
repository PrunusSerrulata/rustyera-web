#!/usr/bin/env bash
set -euo pipefail

arguments=()
for argument in "$@"; do
  if [[ "$argument" == "--target=wasm32-unknown-unknown" ]]; then
    arguments+=("--target=wasm32-freestanding")
  else
    arguments+=("$argument")
  fi
done

exec zig cc "${arguments[@]}"
