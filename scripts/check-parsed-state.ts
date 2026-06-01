// @ts-nocheck
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, "dist");

const EPS = 1e-9;

const REF_FIELDS = new Set(["valve", "waterSource", "controller", "dripStart", "mp", "wr", "swr"]);
const REF_LIST_FIELDS = new Set(["sprinklers", "lps", "dls", "valves", "qcs", "mps", "wrs", "swrs", "sensors"]);

type Diagnostic = {
  severity: "error" | "warn";
  code: string;
  message: string;
  check: string;
  data?: Record<string, unknown>;
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

function collectUidsFromLayers(layers: Record<string, unknown>): Map<number, string> {
  const uidToPath = new Map<number, string>();

  function walk(obj: unknown, p: string): void {
    if (isObject(obj)) {
      const uid = asNumber(obj.uid);
      if (uid !== null) {
        uidToPath.set(uid, p);
      }
      for (const [k, v] of Object.entries(obj)) {
        walk(v, `${p}.${k}`);
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${p}[${i}]`));
    }
  }

  walk(layers, "layers");
  return uidToPath;
}

function findDanglingRefs(layers: Record<string, unknown>, uidSet: Set<number>): Diagnostic[] {
  const out: Diagnostic[] = [];

  function walk(obj: unknown, p: string): void {
    if (!isObject(obj)) {
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (REF_FIELDS.has(k) && typeof v === "number" && Number.isFinite(v) && !uidSet.has(v)) {
        out.push({
          severity: "error",
          code: "DANGLING_REF",
          message: `${p}.${k} = ${v} (no item with this uid)`,
          check: "dangling-refs",
          data: { path: `${p}.${k}`, field: k, uid: v }
        });
      }
      if (REF_LIST_FIELDS.has(k) && Array.isArray(v)) {
        v.forEach((item, i) => {
          if (typeof item === "number" && Number.isFinite(item) && !uidSet.has(item)) {
            out.push({
              severity: "error",
              code: "DANGLING_REF",
              message: `${p}.${k}[${i}] = ${item} (no item with this uid)`,
              check: "dangling-refs",
              data: { path: `${p}.${k}[${i}]`, field: k, uid: item }
            });
          }
        });
      }
      walk(v, `${p}.${k}`);
    }
  }

  walk(layers, "layers");
  return out;
}

function findDuplicateUids(uidToPath: Map<number, string>): Diagnostic[] {
  const counts = new Map<number, string[]>();
  for (const [uid, loc] of uidToPath) {
    if (!counts.has(uid)) {
      counts.set(uid, []);
    }
    counts.get(uid).push(loc);
  }
  const out: Diagnostic[] = [];
  for (const [uid, paths] of counts) {
    if (paths.length > 1) {
      out.push({
        severity: "error",
        code: "DUPLICATE_UID",
        message: `uid ${uid} appears ${paths.length} times`,
        check: "duplicate-uids",
        data: { uid, paths }
      });
    }
  }
  return out;
}

function findLplocIssues(
  layers: Record<string, unknown>,
  uidSet: Set<number>,
  lateralBySegmentUid: Map<number, Record<string, unknown>>
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const layerName of Object.keys(layers)) {
    const items = getLayerItems(layers, layerName);
    for (const item of items) {
      const itemUid = getItemUid(item);
      const lploc = asArray(item.lploc);
      if (lploc.length === 0 && "lploc" in item) {
        out.push({
          severity: "warn",
          code: "LPLOC_EMPTY",
          message: `${layerName} uid=${itemUid}: lploc is []`,
          check: "lploc",
          data: { layer: layerName, itemUid }
        });
        continue;
      }
      if (lploc.length > 0) {
        const segUid = asNumber(lploc[0]);
        if (segUid === null) {
          continue;
        }
        if (!uidSet.has(segUid)) {
          out.push({
            severity: "error",
            code: "LPLOC_BAD_UID",
            message: `${layerName} uid=${itemUid}: lploc[0]=${segUid} (no such uid)`,
            check: "lploc",
            data: { layer: layerName, itemUid, segUid }
          });
        } else if (!lateralBySegmentUid.has(segUid)) {
          out.push({
            severity: "warn",
            code: "LPLOC_NOT_SEGMENT",
            message: `${layerName} uid=${itemUid}: lploc[0]=${segUid} is not a lateral lineData segment uid`,
            check: "lploc",
            data: { layer: layerName, itemUid, segUid }
          });
        }
      }
    }
  }
  return out;
}

function buildLateralBySegment(layers: Record<string, unknown>): Map<number, Record<string, unknown>> {
  const lateralBySegmentUid = new Map<number, Record<string, unknown>>();
  for (const lateral of getLayerItems(layers, "lateralPipes")) {
    for (const segment of asArray<Record<string, unknown>>(lateral.lineData).filter(isObject)) {
      const segmentUid = asNumber(segment.uid);
      if (segmentUid !== null) {
        lateralBySegmentUid.set(segmentUid, lateral);
      }
    }
  }
  return lateralBySegmentUid;
}

function buildConsumerIndex(layers: Record<string, unknown>) {
  const consumersByUid = new Map<number, { layer: string; item: Record<string, unknown> }>();
  for (const layerName of ["sprinklers", "dripStarts"]) {
    const items = getLayerItems(layers, layerName);
    for (const item of items) {
      const uid = getItemUid(item);
      if (uid !== null) {
        consumersByUid.set(uid, { layer: layerName, item });
      }
    }
  }
  return consumersByUid;
}

/** Relative l/h/v with zero delta (e.g. l0,0) in SVG pathData. */
function pathDataZeroLengthIssues(pathData: string): string[] {
  const reasons: string[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pathData)) !== null) {
    const cmd = m[1];
    const raw = m[2].trim();
    if (!raw) {
      continue;
    }
    const nums = raw
      .split(/[\s,]+/)
      .map((s) => Number.parseFloat(s))
      .filter((n) => Number.isFinite(n));
    const lower = cmd.toLowerCase();
    if (cmd !== lower) {
      continue;
    }
    if (lower === "l") {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (Math.abs(nums[i]) < EPS && Math.abs(nums[i + 1]) < EPS) {
          reasons.push(`l${nums[i]},${nums[i + 1]}`);
        }
      }
    } else if (lower === "h") {
      for (const dx of nums) {
        if (Math.abs(dx) < EPS) {
          reasons.push(`h${dx}`);
        }
      }
    } else if (lower === "v") {
      for (const dy of nums) {
        if (Math.abs(dy) < EPS) {
          reasons.push(`v${dy}`);
        }
      }
    }
  }
  return reasons;
}

/** True if pathData contains at least one relative lineto command `l` (token, not inside numbers). */
function pathHasRelativeLinetoCommand(pathData: string): boolean {
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pathData)) !== null) {
    if (m[1] === "l") {
      return true;
    }
  }
  return false;
}

/** Lateral / main pipe segments whose pathData has no relative `l` (often error-prone or zero-length). */
function findPipePathDataMissingRelativeL(layers: Record<string, unknown>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const pipeLayers = ["lateralPipes", "mainPipes"] as const;

  for (const layerName of pipeLayers) {
    const items = getLayerItems(layers, layerName);
    for (let pipeIdx = 0; pipeIdx < items.length; pipeIdx += 1) {
      const pipe = items[pipeIdx];
      const pipeUid = getItemUid(pipe);
      const segments = asArray<Record<string, unknown>>(pipe.lineData).filter(isObject);
      for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
        const seg = segments[segIdx];
        const pathData = seg.pathData;
        const segUid = asNumber(seg.uid);
        if (typeof pathData !== "string") {
          out.push({
            severity: "warn",
            code: "PIPE_PATHDATA_MISSING",
            message: `${layerName}[${pipeIdx}] pipe uid=${pipeUid} lineData[${segIdx}] segment uid=${segUid}: pathData missing or not a string`,
            check: "pipe-path-no-relative-l",
            data: { layerName, pipeIdx, pipeUid, segIdx, segUid }
          });
          continue;
        }
        const trimmed = pathData.trim();
        if (trimmed.length === 0) {
          out.push({
            severity: "warn",
            code: "PIPE_PATHDATA_EMPTY",
            message: `${layerName}[${pipeIdx}] pipe uid=${pipeUid} lineData[${segIdx}] segment uid=${segUid}: pathData is empty`,
            check: "pipe-path-no-relative-l",
            data: { layerName, pipeIdx, pipeUid, segIdx, segUid }
          });
          continue;
        }
        if (!pathHasRelativeLinetoCommand(pathData)) {
          out.push({
            severity: "warn",
            code: "PIPE_PATH_NO_RELATIVE_L",
            message: `${layerName}[${pipeIdx}] pipe uid=${pipeUid} lineData[${segIdx}] segment uid=${segUid}: pathData has no relative 'l' command (no length / unusual geometry)`,
            check: "pipe-path-no-relative-l",
            data: {
              layerName,
              pipeIdx,
              pipeUid,
              segIdx,
              segUid,
              snippet: pathData.length > 120 ? `${pathData.slice(0, 120)}…` : pathData
            }
          });
        }
      }
    }
  }
  return out;
}

function collectPathDataLocations(layers: Record<string, unknown>): { path: string; pathData: string; contextUid: number | null }[] {
  const results: { path: string; pathData: string; contextUid: number | null }[] = [];

  function walk(obj: unknown, p: string, nearestUid: number | null): void {
    if (isObject(obj)) {
      const uid = asNumber(obj.uid);
      const nextUid = uid !== null ? uid : nearestUid;
      if (typeof obj.pathData === "string" && obj.pathData.length > 0) {
        results.push({ path: `${p}.pathData`, pathData: obj.pathData, contextUid: nextUid });
      }
      for (const [k, v] of Object.entries(obj)) {
        walk(v, `${p}.${k}`, nextUid);
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${p}[${i}]`, nearestUid));
    }
  }

  walk(layers, "layers", null);
  return results;
}

function findZeroLengthPathSegments(layers: Record<string, unknown>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const { path, pathData, contextUid } of collectPathDataLocations(layers)) {
    const issues = pathDataZeroLengthIssues(pathData);
    for (const detail of issues) {
      out.push({
        severity: "warn",
        code: "PATH_ZERO_LENGTH",
        message: `${path}: zero-length relative segment (${detail})`,
        check: "path-zero-length",
        data: { path, contextUid, detail, snippet: pathData.length > 120 ? `${pathData.slice(0, 120)}…` : pathData }
      });
    }
  }
  return out;
}

function findValveLpsMismatch(layers: Record<string, unknown>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lps = getLayerItems(layers, "lateralPipes");
  const valves = getLayerItems(layers, "valvesLayer");
  const lpUids = new Set(lps.map((lp) => getItemUid(lp)).filter((u) => u !== null));

  for (const v of valves) {
    const vUid = getItemUid(v);
    if (vUid === null) {
      continue;
    }
    const vLps = asArray<number>(v.lps).filter((x) => typeof x === "number");
    const pointing = new Set(lps.filter((lp) => asNumber(lp.valve) === vUid).map((lp) => getItemUid(lp)).filter((u) => u !== null));

    const inLpsNotPointing = vLps.filter((uid) => pointing.has(uid) === false && lpUids.has(uid));
    const pointingNotInLps = [...pointing].filter((uid) => !vLps.includes(uid));

    for (const uid of inLpsNotPointing) {
      out.push({
        severity: "warn",
        code: "VALVE_LPS_ORPHAN",
        message: `Valve ${vUid}: lps includes lateral ${uid} but that pipe has valve !== ${vUid}`,
        check: "valve-lps",
        data: { valveUid: vUid, lateralUid: uid }
      });
    }
    for (const uid of pointingNotInLps) {
      out.push({
        severity: "warn",
        code: "VALVE_LPS_MISSING",
        message: `Valve ${vUid}: lateral ${uid} has valve=${vUid} but is not in valve.lps`,
        check: "valve-lps",
        data: { valveUid: vUid, lateralUid: uid }
      });
    }
    for (const uid of vLps) {
      if (!lpUids.has(uid)) {
        out.push({
          severity: "error",
          code: "VALVE_LPS_UNKNOWN",
          message: `Valve ${vUid}: lps includes ${uid} which is not a lateral pipe uid`,
          check: "valve-lps",
          data: { valveUid: vUid, lateralUid: uid }
        });
      }
    }
  }
  return out;
}

function findValveFieldWrongLayer(layers: Record<string, unknown>, uidToPath: Map<number, string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lps = getLayerItems(layers, "lateralPipes");
  lps.forEach((lp, i) => {
    const v = asNumber(lp.valve);
    if (v === null) {
      return;
    }
    const loc = uidToPath.get(v);
    if (loc && !loc.includes("valvesLayer")) {
      out.push({
        severity: "error",
        code: "VALVE_POINTS_TO_NON_VALVE",
        message: `lateralPipes[${i}] uid=${getItemUid(lp)}: valve=${v} resolves to ${loc} (not valvesLayer)`,
        check: "lateral-valve-target",
        data: { lateralIndex: i, lateralUid: getItemUid(lp), valveUid: v, targetPath: loc }
      });
    }
  });
  return out;
}

function uidInLayer(uidToPath: Map<number, string>, uid: number, layerName: string): boolean {
  const loc = uidToPath.get(uid);
  return !!loc && loc.includes(`.${layerName}.`);
}

function findWrongLayerTargets(layers: Record<string, unknown>, uidToPath: Map<number, string>): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const v of getLayerItems(layers, "valvesLayer")) {
    const vUid = getItemUid(v);
    const mp = asNumber(v.mp);
    if (mp !== null && !uidInLayer(uidToPath, mp, "mainPipes")) {
      out.push({
        severity: "error",
        code: "VALVE_MP_WRONG_LAYER",
        message: `Valve uid=${vUid}: mp=${mp} is not a mainPipe (${uidToPath.get(mp) ?? "missing"})`,
        check: "wrong-layer-target",
        data: { valveUid: vUid, mpUid: mp }
      });
    }
    const wr = asNumber(v.wr);
    if (wr !== null && !uidInLayer(uidToPath, wr, "wiresLayer")) {
      out.push({
        severity: "error",
        code: "VALVE_WR_WRONG_LAYER",
        message: `Valve uid=${vUid}: wr=${wr} is not a wiresLayer item (${uidToPath.get(wr) ?? "missing"})`,
        check: "wrong-layer-target",
        data: { valveUid: vUid, wrUid: wr }
      });
    }
  }

  for (const qc of getLayerItems(layers, "quickCoupLayer")) {
    const qcUid = getItemUid(qc);
    const mp = asNumber(qc.mp);
    if (mp !== null && !uidInLayer(uidToPath, mp, "mainPipes")) {
      out.push({
        severity: "error",
        code: "QC_MP_WRONG_LAYER",
        message: `Quick coup uid=${qcUid}: mp=${mp} is not a mainPipe (${uidToPath.get(mp) ?? "missing"})`,
        check: "wrong-layer-target",
        data: { qcUid, mpUid: mp }
      });
    }
  }

  for (const s of getLayerItems(layers, "sensorsLayer")) {
    const sUid = getItemUid(s);
    const swr = asNumber(s.swr);
    if (swr !== null && !uidInLayer(uidToPath, swr, "senswirelessLayer")) {
      out.push({
        severity: "error",
        code: "SENSOR_SWR_WRONG_LAYER",
        message: `Sensor uid=${sUid}: swr=${swr} is not senswirelessLayer (${uidToPath.get(swr) ?? "missing"})`,
        check: "wrong-layer-target",
        data: { sensorUid: sUid, swrUid: swr }
      });
    }
  }

  for (const mp of getLayerItems(layers, "mainPipes")) {
    const mpUid = getItemUid(mp);
    const ws = asNumber(mp.waterSource);
    if (ws !== null && !uidInLayer(uidToPath, ws, "waterSources")) {
      out.push({
        severity: "error",
        code: "MP_WATER_SOURCE_WRONG_LAYER",
        message: `Main pipe uid=${mpUid}: waterSource=${ws} is not waterSources (${uidToPath.get(ws) ?? "missing"})`,
        check: "wrong-layer-target",
        data: { mainPipeUid: mpUid, waterSourceUid: ws }
      });
    }
  }

  return out;
}

function findSystemMutualLinks(layers: Record<string, unknown>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const mainPipes = getLayerItems(layers, "mainPipes");
  const mainPipeByUid = new Map<number, Record<string, unknown>>();
  for (const mp of mainPipes) {
    const uid = getItemUid(mp);
    if (uid !== null) {
      mainPipeByUid.set(uid, mp);
    }
  }

  const valves = getLayerItems(layers, "valvesLayer");
  const valveByUid = new Map<number, Record<string, unknown>>();
  for (const v of valves) {
    const uid = getItemUid(v);
    if (uid !== null) {
      valveByUid.set(uid, v);
    }
  }

  const qcs = getLayerItems(layers, "quickCoupLayer");
  const qcByUid = new Map<number, Record<string, unknown>>();
  for (const qc of qcs) {
    const uid = getItemUid(qc);
    if (uid !== null) {
      qcByUid.set(uid, qc);
    }
  }

  const waterSources = getLayerItems(layers, "waterSources");
  const wires = getLayerItems(layers, "wiresLayer");
  const wireByUid = new Map<number, Record<string, unknown>>();
  for (const w of wires) {
    const uid = getItemUid(w);
    if (uid !== null) {
      wireByUid.set(uid, w);
    }
  }

  const controllers = getLayerItems(layers, "controllers");
  const controllerByUid = new Map<number, Record<string, unknown>>();
  for (const c of controllers) {
    const uid = getItemUid(c);
    if (uid !== null) {
      controllerByUid.set(uid, c);
    }
  }

  const sensWireless = getLayerItems(layers, "senswirelessLayer");
  const swByUid = new Map<number, Record<string, unknown>>();
  for (const sw of sensWireless) {
    const uid = getItemUid(sw);
    if (uid !== null) {
      swByUid.set(uid, sw);
    }
  }

  const sensors = getLayerItems(layers, "sensorsLayer");
  const sensorByUid = new Map<number, Record<string, unknown>>();
  for (const s of sensors) {
    const uid = getItemUid(s);
    if (uid !== null) {
      sensorByUid.set(uid, s);
    }
  }

  for (const mp of mainPipes) {
    const mpUid = getItemUid(mp);
    if (mpUid === null) {
      continue;
    }
    const wsUid = asNumber(mp.waterSource);
    if (wsUid !== null) {
      const ws = waterSources.find((w) => getItemUid(w) === wsUid);
      if (ws) {
        const mps = asArray<number>(ws.mps);
        if (!mps.includes(mpUid)) {
          out.push({
            severity: "error",
            code: "WATER_SOURCE_MPS_MISSING_MP",
            message: `Main pipe uid=${mpUid} -> waterSource ${wsUid}, but waterSource.mps omits it`,
            check: "system-mutual-links",
            data: { mainPipeUid: mpUid, waterSourceUid: wsUid }
          });
        }
      }
    }
    for (const vUid of asArray<number>(mp.valves)) {
      if (typeof vUid !== "number") {
        continue;
      }
      const v = valveByUid.get(vUid);
      if (v && asNumber(v.mp) !== mpUid) {
        out.push({
          severity: "error",
          code: "VALVE_MP_MISMATCH",
          message: `Main pipe uid=${mpUid} lists valve ${vUid}, but valve.mp=${asNumber(v.mp)}`,
          check: "system-mutual-links",
          data: { mainPipeUid: mpUid, valveUid: vUid, valveMp: asNumber(v.mp) }
        });
      }
    }
    for (const qcUid of asArray<number>(mp.qcs)) {
      if (typeof qcUid !== "number") {
        continue;
      }
      const qc = qcByUid.get(qcUid);
      if (qc && asNumber(qc.mp) !== mpUid) {
        out.push({
          severity: "error",
          code: "QC_MP_MISMATCH",
          message: `Main pipe uid=${mpUid} lists qc ${qcUid}, but qc.mp=${asNumber(qc.mp)}`,
          check: "system-mutual-links",
          data: { mainPipeUid: mpUid, qcUid, qcMp: asNumber(qc.mp) }
        });
      }
    }
  }

  for (const ws of waterSources) {
    const wsUid = getItemUid(ws);
    if (wsUid === null) {
      continue;
    }
    for (const mpUid of asArray<number>(ws.mps)) {
      if (typeof mpUid !== "number") {
        continue;
      }
      const mp = mainPipeByUid.get(mpUid);
      if (mp && asNumber(mp.waterSource) !== wsUid) {
        out.push({
          severity: "error",
          code: "MP_WATER_SOURCE_MISMATCH",
          message: `Water source uid=${wsUid} lists main pipe ${mpUid}, but mainPipe.waterSource=${asNumber(mp.waterSource)}`,
          check: "system-mutual-links",
          data: { waterSourceUid: wsUid, mainPipeUid: mpUid, mainPipeWaterSource: asNumber(mp.waterSource) }
        });
      }
    }
  }

  for (const v of valves) {
    const vUid = getItemUid(v);
    if (vUid === null) {
      continue;
    }
    const mpUid = asNumber(v.mp);
    if (mpUid !== null) {
      const mp = mainPipeByUid.get(mpUid);
      if (mp && !asArray<number>(mp.valves).includes(vUid)) {
        out.push({
          severity: "error",
          code: "MP_VALVES_MISSING_VALVE",
          message: `Valve uid=${vUid} -> main pipe ${mpUid}, but mainPipe.valves omits it`,
          check: "system-mutual-links",
          data: { valveUid: vUid, mainPipeUid: mpUid }
        });
      }
    }
    const wrUid = asNumber(v.wr);
    if (wrUid !== null) {
      const wire = wireByUid.get(wrUid);
      if (wire && !asArray<number>(wire.valves).includes(vUid)) {
        out.push({
          severity: "error",
          code: "WIRE_VALVES_MISSING_VALVE",
          message: `Valve uid=${vUid} -> wire ${wrUid}, but wire.valves omits it`,
          check: "system-mutual-links",
          data: { valveUid: vUid, wireUid: wrUid }
        });
      }
    }
  }

  for (const qc of qcs) {
    const qcUid = getItemUid(qc);
    if (qcUid === null) {
      continue;
    }
    const mpUid = asNumber(qc.mp);
    if (mpUid !== null) {
      const mp = mainPipeByUid.get(mpUid);
      if (mp && !asArray<number>(mp.qcs).includes(qcUid)) {
        out.push({
          severity: "error",
          code: "MP_QCS_MISSING_QC",
          message: `Quick coup uid=${qcUid} -> main pipe ${mpUid}, but mainPipe.qcs omits it`,
          check: "system-mutual-links",
          data: { qcUid, mainPipeUid: mpUid }
        });
      }
    }
  }

  for (const wire of wires) {
    const wireUid = getItemUid(wire);
    if (wireUid === null) {
      continue;
    }
    const ctrlUid = asNumber(wire.controller);
    if (ctrlUid !== null) {
      const ctrl = controllerByUid.get(ctrlUid);
      if (ctrl && !asArray<number>(ctrl.wrs).includes(wireUid)) {
        out.push({
          severity: "error",
          code: "CONTROLLER_WRS_MISSING_WIRE",
          message: `Wire uid=${wireUid} -> controller ${ctrlUid}, but controller.wrs omits it`,
          check: "system-mutual-links",
          data: { wireUid, controllerUid: ctrlUid }
        });
      }
    }
    for (const vUid of asArray<number>(wire.valves)) {
      if (typeof vUid !== "number") {
        continue;
      }
      const v = valveByUid.get(vUid);
      if (v && asNumber(v.wr) !== wireUid) {
        out.push({
          severity: "error",
          code: "VALVE_WR_MISMATCH",
          message: `Wire uid=${wireUid} lists valve ${vUid}, but valve.wr=${asNumber(v.wr)}`,
          check: "system-mutual-links",
          data: { wireUid, valveUid: vUid, valveWr: asNumber(v.wr) }
        });
      }
    }
  }

  for (const ctrl of controllers) {
    const ctrlUid = getItemUid(ctrl);
    if (ctrlUid === null) {
      continue;
    }
    for (const wireUid of asArray<number>(ctrl.wrs)) {
      if (typeof wireUid !== "number") {
        continue;
      }
      const wire = wireByUid.get(wireUid);
      if (wire && asNumber(wire.controller) !== ctrlUid) {
        out.push({
          severity: "error",
          code: "WIRE_CONTROLLER_MISMATCH",
          message: `Controller uid=${ctrlUid} lists wire ${wireUid}, but wire.controller=${asNumber(wire.controller)}`,
          check: "system-mutual-links",
          data: { controllerUid: ctrlUid, wireUid, wireController: asNumber(wire.controller) }
        });
      }
    }
    for (const swUid of asArray<number>(ctrl.swrs)) {
      if (typeof swUid !== "number") {
        continue;
      }
      const sw = swByUid.get(swUid);
      if (sw && asNumber(sw.controller) !== ctrlUid) {
        out.push({
          severity: "error",
          code: "SENSWIRELESS_CONTROLLER_MISMATCH",
          message: `Controller uid=${ctrlUid} lists senswireless ${swUid}, but senswireless.controller=${asNumber(sw.controller)}`,
          check: "system-mutual-links",
          data: { controllerUid: ctrlUid, senswirelessUid: swUid, senswirelessController: asNumber(sw.controller) }
        });
      }
    }
  }

  for (const sw of sensWireless) {
    const swUid = getItemUid(sw);
    if (swUid === null) {
      continue;
    }
    const ctrlUid = asNumber(sw.controller);
    if (ctrlUid !== null) {
      const ctrl = controllerByUid.get(ctrlUid);
      if (ctrl && !asArray<number>(ctrl.swrs).includes(swUid)) {
        out.push({
          severity: "error",
          code: "CONTROLLER_SWRS_MISSING_SENSWIRELESS",
          message: `Senswireless uid=${swUid} -> controller ${ctrlUid}, but controller.swrs omits it`,
          check: "system-mutual-links",
          data: { senswirelessUid: swUid, controllerUid: ctrlUid }
        });
      }
    }
    for (const sUid of asArray<number>(sw.sensors)) {
      if (typeof sUid !== "number") {
        continue;
      }
      const sensor = sensorByUid.get(sUid);
      if (sensor && asNumber(sensor.swr) !== swUid) {
        out.push({
          severity: "error",
          code: "SENSOR_SWR_MISMATCH",
          message: `Senswireless uid=${swUid} lists sensor ${sUid}, but sensor.swr=${asNumber(sensor.swr)}`,
          check: "system-mutual-links",
          data: { senswirelessUid: swUid, sensorUid: sUid, sensorSwr: asNumber(sensor.swr) }
        });
      }
    }
  }

  for (const sensor of sensors) {
    const sUid = getItemUid(sensor);
    if (sUid === null) {
      continue;
    }
    const swUid = asNumber(sensor.swr);
    if (swUid !== null) {
      const sw = swByUid.get(swUid);
      if (sw && !asArray<number>(sw.sensors).includes(sUid)) {
        out.push({
          severity: "error",
          code: "SENSWIRELESS_SENSORS_MISSING_SENSOR",
          message: `Sensor uid=${sUid} -> senswireless ${swUid}, but senswireless.sensors omits it`,
          check: "system-mutual-links",
          data: { sensorUid: sUid, senswirelessUid: swUid }
        });
      }
    }
  }

  return out;
}

function findOrphanEntities(layers: Record<string, unknown>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lateralPipes = getLayerItems(layers, "lateralPipes");
  const linkedConsumers = new Set<number>();
  for (const lp of lateralPipes) {
    for (const uid of asArray<number>(lp.sprinklers)) {
      if (typeof uid === "number") {
        linkedConsumers.add(uid);
      }
    }
    if (asNumber(lp.valve) === null) {
      out.push({
        severity: "warn",
        code: "LATERAL_NO_VALVE",
        message: `Lateral pipe uid=${getItemUid(lp)} has no valve assigned`,
        check: "orphans",
        data: { lateralUid: getItemUid(lp) }
      });
    }
  }

  for (const layerName of ["sprinklers", "dripStarts"] as const) {
    for (const item of getLayerItems(layers, layerName)) {
      const uid = getItemUid(item);
      if (uid !== null && !linkedConsumers.has(uid)) {
        out.push({
          severity: "warn",
          code: "CONSUMER_NOT_ON_LATERAL",
          message: `${layerName} uid=${uid} is not listed on any lateralPipe.sprinklers`,
          check: "orphans",
          data: { layer: layerName, consumerUid: uid }
        });
      }
    }
  }

  const dripLines = getLayerItems(layers, "dripLines");
  const dripStarts = getLayerItems(layers, "dripStarts");
  const dripLineByStart = new Map<number, number[]>();
  for (const line of dripLines) {
    const lineUid = getItemUid(line);
    const startUid = asNumber(line.dripStart);
    if (lineUid !== null && startUid !== null) {
      if (!dripLineByStart.has(startUid)) {
        dripLineByStart.set(startUid, []);
      }
      dripLineByStart.get(startUid).push(lineUid);
    }
  }

  for (const start of dripStarts) {
    const startUid = getItemUid(start);
    if (startUid === null) {
      continue;
    }
    const dls = asArray<number>(start.dls);
    const fromLines = dripLineByStart.get(startUid) ?? [];
    if (dls.length === 0 && fromLines.length === 0) {
      out.push({
        severity: "warn",
        code: "DRIP_START_ORPHAN",
        message: `Drip start uid=${startUid} has empty dls and no dripLine.dripStart points to it`,
        check: "orphans",
        data: { dripStartUid: startUid }
      });
    }
  }

  return out;
}

function runChecks(drawingLayers: Record<string, unknown>): Diagnostic[] {
  const uidToPath = collectUidsFromLayers(drawingLayers);
  const uidSet = new Set(uidToPath.keys());
  const lateralBySegmentUid = buildLateralBySegment(drawingLayers);

  const diagnostics: Diagnostic[] = [];
  diagnostics.push(...findDuplicateUids(uidToPath));
  diagnostics.push(...findDanglingRefs(drawingLayers, uidSet));
  diagnostics.push(...findLplocIssues(drawingLayers, uidSet, lateralBySegmentUid));
  diagnostics.push(...findZeroLengthPathSegments(drawingLayers));
  diagnostics.push(...findPipePathDataMissingRelativeL(drawingLayers));
  diagnostics.push(...findValveLpsMismatch(drawingLayers));
  diagnostics.push(...findValveFieldWrongLayer(drawingLayers, uidToPath));
  diagnostics.push(...findWrongLayerTargets(drawingLayers, uidToPath));
  diagnostics.push(...findSystemMutualLinks(drawingLayers));
  diagnostics.push(...findOrphanEntities(drawingLayers));

  const consumersByUid = buildConsumerIndex(drawingLayers);
  const lateralPipes = getLayerItems(drawingLayers, "lateralPipes");
  const segMap = lateralBySegmentUid;

  const dripLines = getLayerItems(drawingLayers, "dripLines");
  const dripStarts = getLayerItems(drawingLayers, "dripStarts");
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
    if (lineUid === null) {
      continue;
    }
    const dripStartUid = asNumber(line.dripStart);
    if (dripStartUid === null) {
      diagnostics.push({
        severity: "warn",
        code: "DRIP_LINE_NO_DRIP_START",
        message: `Drip line uid=${lineUid} has no dripStart`,
        check: "dripline-dripstart-mutual",
        data: { dripLineUid: lineUid }
      });
      continue;
    }
    const dripStart = dripStartByUid.get(dripStartUid);
    if (!dripStart) {
      diagnostics.push({
        severity: "error",
        code: "DRIP_LINE_MISSING_DRIP_START_REF",
        message: `Drip line uid=${lineUid} references missing dripStart ${dripStartUid}`,
        check: "dripline-dripstart-mutual",
        data: { dripLineUid: lineUid, dripStartUid }
      });
      continue;
    }
    const dls = asArray<number>(dripStart.dls);
    if (!dls.includes(lineUid)) {
      diagnostics.push({
        severity: "error",
        code: "DRIP_MUTUAL_LINK_MISSING_FROM_DRIP_START",
        message: `Drip line uid=${lineUid} -> dripStart ${dripStartUid}, but dripStart.dls does not include this line`,
        check: "dripline-dripstart-mutual",
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
          message: `dripStart uid=${dripStartUid}: dls references missing drip line ${dripLineUid}`,
          check: "dripline-dripstart-mutual",
          data: { dripStartUid, dripLineUid }
        });
        continue;
      }
      const linked = asNumber(line.dripStart);
      if (linked !== dripStartUid) {
        diagnostics.push({
          severity: "error",
          code: "DRIP_MUTUAL_LINK_MISSING_FROM_DRIP_LINE",
          message: `dripStart uid=${dripStartUid}: dls has ${dripLineUid}, but dripLine.dripStart=${linked}`,
          check: "dripline-dripstart-mutual",
          data: { dripStartUid, dripLineUid, dripLineDripStartUid: linked }
        });
      }
    }
  }

  for (const [consumerUid, consumerInfo] of consumersByUid.entries()) {
    const segmentUid = getLplocLateralSegmentUid(consumerInfo.item);
    if (segmentUid === null) {
      diagnostics.push({
        severity: "error",
        code: "CONSUMER_MISSING_LPLOC",
        message: `Consumer uid=${consumerUid} (${consumerInfo.layer}) has no lploc[0]`,
        check: "lateral-consumer-mutual",
        data: { consumerUid, layer: consumerInfo.layer }
      });
      continue;
    }
    const lateralPipe = segMap.get(segmentUid);
    if (!lateralPipe) {
      diagnostics.push({
        severity: "error",
        code: "CONSUMER_POINTS_TO_MISSING_LATERAL",
        message: `Consumer uid=${consumerUid}: lploc[0]=${segmentUid} (no lateral segment)`,
        check: "lateral-consumer-mutual",
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
        message: `Consumer uid=${consumerUid} points to lateral uid=${lateralUid}, but lateral.sprinklers omits it`,
        check: "lateral-consumer-mutual",
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
          message: `Lateral uid=${lateralUid}: sprinklers references missing consumer ${consumerUid}`,
          check: "lateral-consumer-mutual",
          data: { lateralUid, consumerUid }
        });
        continue;
      }
      const segmentUid = getLplocLateralSegmentUid(consumerInfo.item);
      if (segmentUid === null) {
        diagnostics.push({
          severity: "error",
          code: "LATERAL_MUTUAL_LINK_MISSING_FROM_CONSUMER",
          message: `Lateral uid=${lateralUid}: consumer ${consumerUid} has no lploc[0]`,
          check: "lateral-consumer-mutual",
          data: { lateralUid, consumerUid, layer: consumerInfo.layer }
        });
        continue;
      }
      const ownerLateral = segMap.get(segmentUid);
      if (!ownerLateral || ownerLateral !== lateral) {
        diagnostics.push({
          severity: "error",
          code: "LATERAL_MUTUAL_LINK_MISSING_FROM_CONSUMER",
          message: `Lateral uid=${lateralUid}: consumer ${consumerUid} lploc[0] points elsewhere`,
          check: "lateral-consumer-mutual",
          data: {
            lateralUid,
            consumerUid,
            layer: consumerInfo.layer,
            consumerLateralUid: ownerLateral ? getItemUid(ownerLateral) : null,
            consumerLateralSegmentUid: segmentUid
          }
        });
      }
    }
  }

  return diagnostics;
}

async function listParsedFiles(): Promise<string[]> {
  await mkdir(DIST_DIR, { recursive: true });
  const entries = await readdir(DIST_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /_parsed\.json$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function main(): Promise<void> {
  const files = await listParsedFiles();
  if (files.length === 0) {
    console.log("No *_parsed.json files in ./dist");
    return;
  }

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const fileName of files) {
    const fullPath = path.join(DIST_DIR, fileName);
    const raw = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const parsedState = parsed.parsedState;
    if (!isObject(parsedState)) {
      console.warn(`${fileName}: skip (no parsedState)`);
      continue;
    }
    const drawing = parsedState.drawing;
    if (!isObject(drawing)) {
      console.warn(`${fileName}: skip (no parsedState.drawing)`);
      continue;
    }
    const layers = drawing.layers;
    if (!isObject(layers)) {
      console.warn(`${fileName}: skip (no parsedState.drawing.layers)`);
      continue;
    }

    const diagnostics = runChecks(layers as Record<string, unknown>);
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    const warnings = diagnostics.filter((d) => d.severity === "warn").length;
    totalErrors += errors;
    totalWarnings += warnings;

    console.log(`\n${fileName}: ${errors} errors, ${warnings} warnings`);
    const byCheck = new Map<string, Diagnostic[]>();
    for (const d of diagnostics) {
      if (!byCheck.has(d.check)) {
        byCheck.set(d.check, []);
      }
      byCheck.get(d.check).push(d);
    }
    for (const [check, diags] of [...byCheck.entries()].sort()) {
      console.log(`  [${check}] ${diags.length}`);
    }
    const preview = diagnostics.slice(0, 25);
    for (const d of preview) {
      console.log(`    [${d.severity.toUpperCase()}][${d.code}] ${d.message}`);
    }
    if (diagnostics.length > 25) {
      console.log(`    ... ${diagnostics.length - 25} more`);
    }
  }

  console.log(`\nTotal: ${totalErrors} errors, ${totalWarnings} warnings`);
  if (totalErrors > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
