#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

layer="rzwLayer"
out="clean.json"
input="dist/big_parsed.json"

for arg in "$@"; do
  case "$arg" in
    --layer=*)
      layer="${arg#*=}"
      ;;
    --out=*)
      out="${arg#*=}"
      ;;
    --input=*)
      input="${arg#*=}"
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: ./clonesRemover.sh --layer=rzwLayer --out=clean.json [--input=dist/big_parsed.json]" >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"
bun run scripts/remove-layer-position-clones.ts "--layer=$layer" "--out=$out" "--input=$input"
