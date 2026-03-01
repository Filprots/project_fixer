// @ts-nocheck
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, "dist");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const CONSUMER_LAYER_NAMES = ["sprinklers", "dripStarts"];

type Diagnostic = {
  severity: "error" | "warn";
  code: string;
  message: string;
  file: string;
  check: string;
  data?: Record<string, unknown>;
};

type CheckResult = {
  name: string;
  diagnostics: Diagnostic[];
};

type CheckContext = {
  fileName: string;
  parsed: Record<string, unknown>;
  drawingLayers: Record<string, unknown>;
};

type CheckRunner = {
  name: string;
  run: (ctx: CheckContext) => Diagnostic[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getLayerItems(layers: Record<string, unknown>, layerName: string): Record<string, unknown>[] {
  const layer = layers[layerName];
  if (!isObject(layer)) {
    return [];
  }
  return asArray<Record<string, unknown>>(layer.items).filter(isObject);
}

function getItemUid(item: Record<string, unknown>): number | null {
  return asNumber(item.uid);
}

function getLplocLateralSegmentUid(item: Record<string, unknown>): number | null {
  const lploc = asArray(item.lploc);
  if (lploc.length === 0) {
    return null;
  }
  return asNumber(lploc[0]);
}

function buildConsumerIndex(layers: Record<string, unknown>) {
  const consumersByUid = new Map<number, { layer: string; item: Record<string, unknown> }>();
  for (const layerName of CONSUMER_LAYER_NAMES) {
    const items = getLayerItems(layers, layerName);
    for (const item of items) {
      const uid = getItemUid(item);
      if (uid === null) {
        continue;
      }
      consumersByUid.set(uid, { layer: layerName, item });
    }
  }
  return consumersByUid;
}

function buildLateralMaps(layers: Record<string, unknown>) {
  const lateralPipes = getLayerItems(layers, "lateralPipes");
  const lateralByPipeUid = new Map<number, Record<string, unknown>>();
  const lateralBySegmentUid = new Map<number, Record<string, unknown>>();

  for (const lateral of lateralPipes) {
    const pipeUid = getItemUid(lateral);
    if (pipeUid !== null) {
      lateralByPipeUid.set(pipeUid, lateral);
    }

    for (const segment of asArray<Record<string, unknown>>(lateral.lineData).filter(isObject)) {
      const segmentUid = asNumber(segment.uid);
      if (segmentUid === null) {
        continue;
      }
      lateralBySegmentUid.set(segmentUid, lateral);
    }
  }

  return { lateralPipes, lateralByPipeUid, lateralBySegmentUid };
}

const checkDripLineDripStartMutual: CheckRunner = {
  name: "dripline-dripstart-mutual",
  run(ctx) {
    const diagnostics: Diagnostic[] = [];
    const dripLines = getLayerItems(ctx.drawingLayers, "dripLines");
    const dripStarts = getLayerItems(ctx.drawingLayers, "dripStarts");

    const dripLineByUid = new Map<number, Record<string, unknown>>();
    for (const line of dripLines) {
      const uid = getItemUid(line);
      if (uid !== null) {
        dripLineByUid.set(uid, line);
      }
    }

    const dripStartByUid = new Map<number, Record<string, unknown>>();
    for (const start of dripStarts) {
      const uid = getItemUid(start);
      if (uid !== null) {
        dripStartByUid.set(uid, start);
      }
    }

    for (const line of dripLines) {
      const lineUid = getItemUid(line);
      const dripStartUid = asNumber(line.dripStart);
      if (lineUid === null) {
        continue;
      }

      if (dripStartUid === null) {
        diagnostics.push({
          severity: "error",
          code: "DRIP_LINE_NO_DRIP_START",
          message: "Drip line has no dripStart link.",
          file: ctx.fileName,
          check: this.name,
          data: { dripLineUid: lineUid }
        });
        diagnostics.push({
          severity: "error",
          code: "DRIP_LINE_ORPHAN",
          message: "Drip line is not connected to any dripStart.",
          file: ctx.fileName,
          check: this.name,
          data: { dripLineUid: lineUid }
        });
        continue;
      }

      const dripStart = dripStartByUid.get(dripStartUid);
      if (!dripStart) {
        diagnostics.push({
          severity: "error",
          code: "DRIP_LINE_MISSING_DRIP_START_REF",
          message: "Drip line references a non-existing dripStart.",
          file: ctx.fileName,
          check: this.name,
          data: { dripLineUid: lineUid, dripStartUid }
        });
        diagnostics.push({
          severity: "error",
          code: "DRIP_LINE_ORPHAN",
          message: "Drip line is not connected to any valid dripStart.",
          file: ctx.fileName,
          check: this.name,
          data: { dripLineUid: lineUid, dripStartUid }
        });
        continue;
      }

      const dls = asArray<number>(dripStart.dls);
      if (!dls.includes(lineUid)) {
        diagnostics.push({
          severity: "error",
          code: "DRIP_MUTUAL_LINK_MISSING_FROM_DRIP_START",
          message: "Drip line points to dripStart, but dripStart.dls does not include this drip line.",
          file: ctx.fileName,
          check: this.name,
          data: { dripLineUid: lineUid, dripStartUid }
        });
      }
    }

    for (const start of dripStarts) {
      const dripStartUid = getItemUid(start);
      if (dripStartUid === null) {
        continue;
      }
      const dls = asArray<number>(start.dls);
      for (const dripLineUid of dls) {
        if (typeof dripLineUid !== "number") {
          continue;
        }
        const line = dripLineByUid.get(dripLineUid);
        if (!line) {
          diagnostics.push({
            severity: "error",
            code: "DRIP_START_POINTS_TO_MISSING_LINE",
            message: "dripStart.dls references non-existing drip line.",
            file: ctx.fileName,
            check: this.name,
            data: { dripStartUid, dripLineUid }
          });
          continue;
        }
        const linkedDripStartUid = asNumber(line.dripStart);
        if (linkedDripStartUid !== dripStartUid) {
          diagnostics.push({
            severity: "error",
            code: "DRIP_MUTUAL_LINK_MISSING_FROM_DRIP_LINE",
            message: "dripStart.dls references drip line, but drip line points to another dripStart.",
            file: ctx.fileName,
            check: this.name,
            data: { dripStartUid, dripLineUid, dripLineDripStartUid: linkedDripStartUid }
          });
        }
      }
    }

    return diagnostics;
  }
};

const checkLateralConsumerMutual: CheckRunner = {
  name: "lateral-consumer-mutual",
  run(ctx) {
    const diagnostics: Diagnostic[] = [];
    const consumersByUid = buildConsumerIndex(ctx.drawingLayers);
    const { lateralPipes, lateralBySegmentUid } = buildLateralMaps(ctx.drawingLayers);

    for (const [consumerUid, consumerInfo] of consumersByUid.entries()) {
      const segmentUid = getLplocLateralSegmentUid(consumerInfo.item);
      if (segmentUid === null) {
        diagnostics.push({
          severity: "error",
          code: "CONSUMER_MISSING_LPLOC",
          message: "Consumer does not have lploc[0] lateral segment uid.",
          file: ctx.fileName,
          check: this.name,
          data: { consumerUid, layer: consumerInfo.layer }
        });
        continue;
      }

      const lateralPipe = lateralBySegmentUid.get(segmentUid);
      if (!lateralPipe) {
        diagnostics.push({
          severity: "error",
          code: "CONSUMER_POINTS_TO_MISSING_LATERAL",
          message: "Consumer lploc[0] points to missing lateral line segment.",
          file: ctx.fileName,
          check: this.name,
          data: { consumerUid, layer: consumerInfo.layer, lateralSegmentUid: segmentUid }
        });
        continue;
      }

      const lateralUid = getItemUid(lateralPipe);
      const linkedConsumers = asArray<number>(lateralPipe.sprinklers);
      if (!linkedConsumers.includes(consumerUid)) {
        diagnostics.push({
          severity: "error",
          code: "LATERAL_MUTUAL_LINK_MISSING_FROM_LATERAL",
          message: "Consumer points to lateral, but lateral.sprinklers does not include the consumer uid.",
          file: ctx.fileName,
          check: this.name,
          data: { consumerUid, layer: consumerInfo.layer, lateralUid, lateralSegmentUid: segmentUid }
        });
      }
    }

    for (const lateral of lateralPipes) {
      const lateralUid = getItemUid(lateral);
      const linkedConsumers = asArray<number>(lateral.sprinklers);
      for (const consumerUid of linkedConsumers) {
        if (typeof consumerUid !== "number") {
          continue;
        }
        const consumerInfo = consumersByUid.get(consumerUid);
        if (!consumerInfo) {
          diagnostics.push({
            severity: "error",
            code: "LATERAL_POINTS_TO_MISSING_CONSUMER",
            message: "Lateral.sprinklers references non-existing consumer.",
            file: ctx.fileName,
            check: this.name,
            data: { lateralUid, consumerUid }
          });
          continue;
        }

        const segmentUid = getLplocLateralSegmentUid(consumerInfo.item);
        if (segmentUid === null) {
          diagnostics.push({
            severity: "error",
            code: "LATERAL_MUTUAL_LINK_MISSING_FROM_CONSUMER",
            message: "Lateral references consumer, but consumer has no lploc[0].",
            file: ctx.fileName,
            check: this.name,
            data: { lateralUid, consumerUid, layer: consumerInfo.layer }
          });
          continue;
        }

        const ownerLateral = lateralBySegmentUid.get(segmentUid);
        const ownerLateralUid = ownerLateral ? getItemUid(ownerLateral) : null;
        if (!ownerLateral || ownerLateral !== lateral) {
          diagnostics.push({
            severity: "error",
            code: "LATERAL_MUTUAL_LINK_MISSING_FROM_CONSUMER",
            message: "Lateral references consumer, but consumer lploc[0] points to a different lateral segment.",
            file: ctx.fileName,
            check: this.name,
            data: { lateralUid, consumerUid, layer: consumerInfo.layer, consumerLateralUid: ownerLateralUid, consumerLateralSegmentUid: segmentUid }
          });
        }
      }
    }

    return diagnostics;
  }
};

const CHECKS: CheckRunner[] = [checkDripLineDripStartMutual, checkLateralConsumerMutual];

async function listParsedFiles(): Promise<string[]> {
  await mkdir(DIST_DIR, { recursive: true });
  const entries = await readdir(DIST_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /_parsed\.json$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function buildContext(fileName: string, parsed: Record<string, unknown>): CheckContext | null {
  const parsedState = parsed.parsedState;
  if (!isObject(parsedState)) {
    return null;
  }

  const drawing = parsedState.drawing;
  if (!isObject(drawing)) {
    return null;
  }

  const layers = drawing.layers;
  if (!isObject(layers)) {
    return null;
  }

  return {
    fileName,
    parsed,
    drawingLayers: layers
  };
}

function summarize(results: CheckResult[]): { totalErrors: number; totalWarnings: number } {
  let totalErrors = 0;
  let totalWarnings = 0;
  for (const result of results) {
    for (const diag of result.diagnostics) {
      if (diag.severity === "error") {
        totalErrors += 1;
      } else {
        totalWarnings += 1;
      }
    }
  }
  return { totalErrors, totalWarnings };
}

async function main(): Promise<void> {
  const parsedFiles = await listParsedFiles();
  if (parsedFiles.length === 0) {
    console.log("No parsed files found in ./dist (expected *_parsed.json)");
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const fileName of parsedFiles) {
    const fullPath = path.join(DIST_DIR, fileName);
    const raw = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ctx = buildContext(fileName, parsed);
    if (!ctx) {
      console.warn(`Skipping ${fileName}: missing parsedState.drawing.layers`);
      continue;
    }

    const results: CheckResult[] = CHECKS.map((check) => ({
      name: check.name,
      diagnostics: check.run(ctx)
    }));

    const summary = summarize(results);
    const allDiagnostics = results.flatMap((r) => r.diagnostics);
    const report = {
      file: fileName,
      generatedAt: new Date().toISOString(),
      summary,
      checks: results
    };

    const outName = fileName.replace(/_parsed\.json$/i, "_analysis.json");
    const outPath = path.join(OUTPUT_DIR, outName);
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log(
      `${fileName}: ${summary.totalErrors} errors, ${summary.totalWarnings} warnings -> output/${outName}`
    );
    for (const diag of allDiagnostics.slice(0, 20)) {
      console.log(`  [${diag.code}] ${diag.message}`);
    }
    if (allDiagnostics.length > 20) {
      console.log(`  ... ${allDiagnostics.length - 20} more diagnostics`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
