// @ts-nocheck
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

type CliOptions = {
  input: string;
  output: string;
  layer: string;
};

function parseArgs(argv: string[]): CliOptions {
  const root = process.cwd();
  const options: CliOptions = {
    input: path.join(root, "dist", "big_parsed.json"),
    output: path.join(root, "clean.json"),
    layer: "rzwLayer"
  };

  for (const arg of argv) {
    if (arg.startsWith("--input=")) {
      options.input = path.resolve(root, arg.slice("--input=".length));
      continue;
    }
    if (arg.startsWith("--out=")) {
      options.output = path.resolve(root, arg.slice("--out=".length));
      continue;
    }
    if (arg.startsWith("--layer=")) {
      options.layer = arg.slice("--layer=".length).trim();
      continue;
    }
  }

  if (!options.layer) {
    throw new Error("Missing --layer value.");
  }

  return options;
}

function stripTrailingComma(text: string): string {
  return text.replace(/,\s*$/, "");
}

function braceDeltaIgnoringStrings(line: string): number {
  let delta = 0;
  let inString = false;
  let escaped = false;

  for (const char of line) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      delta += 1;
    } else if (char === "}") {
      delta -= 1;
    }
  }

  return delta;
}

function normalizePositionKey(item: Record<string, unknown>): string | null {
  const position = item.position;
  if (!Array.isArray(position) || position.length < 2) {
    return null;
  }
  return JSON.stringify(position);
}

async function removeClonesByPosition(options: CliOptions): Promise<void> {
  await mkdir(path.dirname(options.output), { recursive: true });

  const input = createReadStream(options.input, { encoding: "utf8" });
  const output = createWriteStream(options.output, { encoding: "utf8" });
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity
  });

  let sawTargetLayer = false;
  let inTargetLayer = false;
  let targetLayerDepth = 0;
  let inTargetItemsArray = false;

  let collectingItem = false;
  let currentItemDepth = 0;
  let currentItemLines: string[] = [];
  let pendingKeptItemText: string | null = null;

  const seenPositions = new Set<string>();
  let totalItems = 0;
  let uniqueItems = 0;
  let removedItems = 0;
  let missingPositionItems = 0;

  for await (const line of rl) {
    const trimmed = line.trim();

    if (!inTargetLayer && line.includes(`"${options.layer}"`) && line.includes("{")) {
      sawTargetLayer = true;
      inTargetLayer = true;
      targetLayerDepth = braceDeltaIgnoringStrings(line);
      output.write(`${line}\n`);
      continue;
    }

    if (inTargetLayer && !inTargetItemsArray) {
      if (/"items"\s*:\s*\[/.test(line)) {
        inTargetItemsArray = true;
        output.write(`${line}\n`);
        continue;
      }

      targetLayerDepth += braceDeltaIgnoringStrings(line);
      output.write(`${line}\n`);
      if (targetLayerDepth <= 0) {
        inTargetLayer = false;
      }
      continue;
    }

    if (inTargetItemsArray) {
      if (!collectingItem) {
        if (trimmed.startsWith("{")) {
          collectingItem = true;
          currentItemLines = [line];
          currentItemDepth = braceDeltaIgnoringStrings(line);
          continue;
        }

        if (trimmed.startsWith("]")) {
          if (pendingKeptItemText !== null) {
            output.write(`${pendingKeptItemText}\n`);
            pendingKeptItemText = null;
          }
          output.write(`${line}\n`);
          inTargetItemsArray = false;
          continue;
        }

        output.write(`${line}\n`);
        continue;
      }

      currentItemLines.push(line);
      currentItemDepth += braceDeltaIgnoringStrings(line);

      if (currentItemDepth === 0) {
        collectingItem = false;
        totalItems += 1;

        const rawItemText = currentItemLines.join("\n");
        const itemParseText = stripTrailingComma(rawItemText.trimEnd());
        currentItemLines = [];

        let itemObj: Record<string, unknown> | null = null;
        try {
          itemObj = JSON.parse(itemParseText) as Record<string, unknown>;
        } catch {
          // Keep unparsable item to avoid data loss.
          if (pendingKeptItemText !== null) {
            output.write(`${pendingKeptItemText},\n`);
          }
          pendingKeptItemText = stripTrailingComma(rawItemText);
          uniqueItems += 1;
          continue;
        }

        const positionKey = normalizePositionKey(itemObj);
        if (positionKey === null) {
          missingPositionItems += 1;
          if (pendingKeptItemText !== null) {
            output.write(`${pendingKeptItemText},\n`);
          }
          pendingKeptItemText = stripTrailingComma(rawItemText);
          uniqueItems += 1;
          continue;
        }

        if (seenPositions.has(positionKey)) {
          removedItems += 1;
          continue;
        }

        seenPositions.add(positionKey);
        if (pendingKeptItemText !== null) {
          output.write(`${pendingKeptItemText},\n`);
        }
        pendingKeptItemText = stripTrailingComma(rawItemText);
        uniqueItems += 1;
      }

      continue;
    }

    output.write(`${line}\n`);
  }

  await new Promise<void>((resolve, reject) => {
    output.end(() => resolve());
    output.on("error", reject);
  });

  if (!sawTargetLayer) {
    throw new Error(`Layer "${options.layer}" not found in file.`);
  }

  console.log(`Layer: ${options.layer}`);
  console.log(`Input: ${options.input}`);
  console.log(`Output: ${options.output}`);
  console.log(`Total items scanned: ${totalItems}`);
  console.log(`Unique positions kept: ${uniqueItems}`);
  console.log(`Duplicates removed: ${removedItems}`);
  if (missingPositionItems > 0) {
    console.log(`Items without valid position kept as-is: ${missingPositionItems}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  await removeClonesByPosition(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
