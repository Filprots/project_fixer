# Mongo State Parser (Bun)

This tool extracts editable `state` objects from stringified `layout` fields in Mongo-exported documents.

## Folders

- `source/` - input Mongo document files (`*.json`)
- `dist/` - parsed editable files (`*_parsed.json`)
- `output/` - reconstructed Mongo documents (`*_fixed.json`)

## Commands

```bash
bun run parse
```

Reads files from `source/` and writes `dist/<name>_parsed.json`.

```bash
bun run fix
```

Reads `dist/<name>_parsed.json`, reinserts edited `state` values into original `source/<name>.json`, and writes `output/<name>_fixed.json`.

```bash
bun run analyze:dripLines
```

Reads `dist/<name>_parsed.json`, analyzes `parsedState.drawing.layers`, and writes `output/<name>_analysis.json` with connectivity diagnostics.

## Parsed File Shape

`dist/<name>_parsed.json` contains:

- `sourceFile`: original source file name
- `items[]`: extracted state entries keyed by:
  - `occurrence`: index of `layout` field occurrence in source text
  - `layoutKey`: key under `layouts` (for example `layout7`)
  - `state`: editable JSON object

Only edit `state` values in `dist` files.

## Current Analyzer Checks

- drip line <-> drip start mutual linking:
  - `dripLines.items[].dripStart` must reference existing `dripStarts.items[].uid`
  - referenced `dripStart.dls[]` must include this drip line uid
  - reverse links in `dripStart.dls[]` must point to existing drip lines and back to the same drip start
- lateral link mutual checks for current consumer layers (`sprinklers`, `dripStarts`):
  - consumer `lploc[0]` must reference an existing lateral line segment uid (`lateralPipes.items[].lineData[].uid`)
  - corresponding lateral `sprinklers[]` must include consumer uid
  - reverse links from lateral `sprinklers[]` must reference existing consumers linked back to the same lateral
