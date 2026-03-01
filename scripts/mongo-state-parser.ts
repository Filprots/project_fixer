// @ts-nocheck
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = process.cwd();
const SOURCE_DIR = path.join(ROOT_DIR, "source");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");

type ParsedFileOutput = {
  sourceFile: string;
  targetField: "state";
  extractedAt: string;
  parsedState: Record<string, unknown>;
  parsedKeys: string[];
  skippedKeys: string[];
};

function getBasenameWithoutExt(fileName: string): string {
  return fileName.replace(/\.json$/i, "");
}

async function listSourceJsonFiles(): Promise<string[]> {
  await mkdir(SOURCE_DIR, { recursive: true });
  const entries = await readdir(SOURCE_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function safeParseJsonStringValue(value: unknown): unknown | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findMatchingBrace(text: string, openBraceIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBraceIndex; i < text.length; i += 1) {
    const char = text[i];

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
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractStateObjectRange(rawDoc: string): { start: number; end: number; objectText: string } | null {
  const stateStartMatch = /"state"\s*:\s*\{/.exec(rawDoc);
  if (!stateStartMatch) {
    return null;
  }

  const stateFieldStart = stateStartMatch.index;
  const openBraceIndex = rawDoc.indexOf("{", stateFieldStart);
  if (openBraceIndex < 0) {
    return null;
  }

  const closeBraceIndex = findMatchingBrace(rawDoc, openBraceIndex);
  if (closeBraceIndex < 0) {
    return null;
  }

  return {
    start: openBraceIndex,
    end: closeBraceIndex,
    objectText: rawDoc.slice(openBraceIndex, closeBraceIndex + 1)
  };
}

async function parseCommand(): Promise<void> {
  const sourceFiles = await listSourceJsonFiles();
  if (sourceFiles.length === 0) {
    console.log("No source JSON files found in ./source");
    return;
  }

  await mkdir(DIST_DIR, { recursive: true });

  for (const sourceFile of sourceFiles) {
    const sourcePath = path.join(SOURCE_DIR, sourceFile);
    const rawDoc = await readFile(sourcePath, "utf8");
    const stateRange = extractStateObjectRange(rawDoc);
    if (!stateRange) {
      console.warn(`Skipping ${sourceFile}: cannot find "state" object`);
      continue;
    }

    let stateObj: Record<string, unknown>;
    try {
      stateObj = JSON.parse(stateRange.objectText) as Record<string, unknown>;
    } catch {
      console.warn(`Skipping ${sourceFile}: cannot parse state object as JSON`);
      continue;
    }

    const parsedState: Record<string, unknown> = {};
    const parsedKeys: string[] = [];
    const skippedKeys: string[] = [];

    for (const [key, value] of Object.entries(stateObj)) {
      const parsedValue = safeParseJsonStringValue(value);
      if (parsedValue === null) {
        skippedKeys.push(key);
        continue;
      }
      parsedState[key] = parsedValue;
      parsedKeys.push(key);
    }

    const parsed: ParsedFileOutput = {
      sourceFile,
      targetField: "state",
      extractedAt: new Date().toISOString(),
      parsedState,
      parsedKeys,
      skippedKeys
    };

    const outPath = path.join(DIST_DIR, `${getBasenameWithoutExt(sourceFile)}_parsed.json`);
    await writeFile(outPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    console.log(`Parsed ${sourceFile} -> dist/${path.basename(outPath)} (${parsed.parsedKeys.length} keys parsed)`);
  }
}

async function fixCommand(): Promise<void> {
  await mkdir(DIST_DIR, { recursive: true });
  const distEntries = await readdir(DIST_DIR, { withFileTypes: true });
  const parsedFiles = distEntries
    .filter((entry) => entry.isFile() && /_parsed\.json$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (parsedFiles.length === 0) {
    console.log("No parsed files found in ./dist (expected *_parsed.json)");
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const parsedFile of parsedFiles) {
    const parsedPath = path.join(DIST_DIR, parsedFile);
    const parsedRaw = await readFile(parsedPath, "utf8");
    const parsed = JSON.parse(parsedRaw) as ParsedFileOutput;

    if (!parsed.sourceFile) {
      console.warn(`Skipping ${parsedFile}: missing sourceFile`);
      continue;
    }

    const sourcePath = path.join(SOURCE_DIR, parsed.sourceFile);
    const sourceRaw = await readFile(sourcePath, "utf8");
    const stateRange = extractStateObjectRange(sourceRaw);
    if (!stateRange) {
      console.warn(`Skipping ${parsedFile}: cannot find "state" object in source`);
      continue;
    }

    let sourceStateObj: Record<string, unknown>;
    try {
      sourceStateObj = JSON.parse(stateRange.objectText) as Record<string, unknown>;
    } catch {
      console.warn(`Skipping ${parsedFile}: cannot parse source state object as JSON`);
      continue;
    }

    const editableState = parsed.parsedState ?? {};
    let updatedKeys = 0;
    for (const [key, value] of Object.entries(editableState)) {
      sourceStateObj[key] = JSON.stringify(value);
      updatedKeys += 1;
    }

    const updatedStateText = JSON.stringify(sourceStateObj, null, 4);
    const fixedRaw =
      sourceRaw.slice(0, stateRange.start) +
      updatedStateText +
      sourceRaw.slice(stateRange.end + 1);

    const sourceBase = getBasenameWithoutExt(parsed.sourceFile);
    const outputPath = path.join(OUTPUT_DIR, `${sourceBase}_fixed.json`);
    await writeFile(outputPath, fixedRaw, "utf8");
    console.log(`Fixed ${parsed.sourceFile} -> output/${path.basename(outputPath)} (${updatedKeys} keys stringified)`);
  }
}

async function main(): Promise<void> {
  const command = Bun.argv[2];
  if (command === "parse") {
    await parseCommand();
    return;
  }
  if (command === "fix") {
    await fixCommand();
    return;
  }

  console.log("Usage:");
  console.log("  bun run parse");
  console.log("  bun run fix");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
