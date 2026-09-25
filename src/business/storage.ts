// 存储业务层：方案数据持久化到浏览器 localStorage，读取时做结构校验与脏数据兜底。
import {
  createPresetPlan,
  type ExitDef,
  type PlanData,
  type SegmentDef,
  type ZoneDef,
} from "./clearance";

const STORAGE_KEY = "fireworks-clearance-plan-v1";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function sanitizeExits(value: unknown): ExitDef[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const r = asRecord(raw) ?? {};
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? "未命名离场口"),
      width: Math.max(0, toNumber(r.width, 0)),
      enabled: r.enabled !== false,
    };
  });
}

function sanitizeZones(value: unknown): ZoneDef[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const r = asRecord(raw) ?? {};
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? "未命名区域"),
      population: Math.max(0, Math.round(toNumber(r.population, 0))),
      exitIds: toStringArray(r.exitIds),
    };
  });
}

function sanitizeSegments(value: unknown): SegmentDef[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const r = asRecord(raw) ?? {};
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? "未命名段落"),
      plannedIgnite: Math.max(0, Math.round(toNumber(r.plannedIgnite, 0))),
      zoneIds: toStringArray(r.zoneIds),
    };
  });
}

function sanitizeOverrides(value: unknown): PlanData["overrides"] {
  const root = asRecord(value);
  if (!root) return {};
  const out: PlanData["overrides"] = {};
  for (const [key, raw] of Object.entries(root)) {
    const r = asRecord(raw);
    if (!r) continue;
    const igniteAt = toNumber(r.igniteAt, NaN);
    if (!Number.isFinite(igniteAt) || typeof r.signature !== "string") continue;
    out[key] = { igniteAt: Math.max(0, Math.round(igniteAt)), signature: r.signature };
  }
  return out;
}

// 存储里的结构必须仍与预置的段落/离场口/区域集合一致，缺项时回退预置。
function isValidShape(data: PlanData): boolean {
  const preset = createPresetPlan();
  const sameIds = (a: { id: string }[], b: { id: string }[]) =>
    a.length === b.length && a.every((item, i) => item.id === b[i]?.id);
  return (
    sameIds(data.exits, preset.exits) &&
    sameIds(data.zones, preset.zones) &&
    sameIds(data.segments, preset.segments)
  );
}

function sanitize(raw: unknown): PlanData {
  const r = asRecord(raw);
  if (!r) return createPresetPlan();
  const data: PlanData = {
    exits: sanitizeExits(r.exits),
    zones: sanitizeZones(r.zones),
    segments: sanitizeSegments(r.segments),
    overrides: sanitizeOverrides(r.overrides),
  };
  return isValidShape(data) ? data : createPresetPlan();
}

export function loadPlan(): PlanData {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    if (!text) return createPresetPlan();
    return sanitize(JSON.parse(text));
  } catch {
    return createPresetPlan();
  }
}

export function savePlan(data: PlanData): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 隐私模式 / 存储已满时静默降级，判定仍可在内存中进行。
  }
}

export function resetPlan(): PlanData {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return createPresetPlan();
}
