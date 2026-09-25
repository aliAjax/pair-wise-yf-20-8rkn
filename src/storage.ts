// 放行核算 · 浏览器存储
// 负责 localStorage 读写、预置数据（三段节目 / 三个离场口 / 各区人数）与数据校验。

import type { ExitGate, Segment, ShowState, Zone } from "./judgment";

const STORAGE_KEY = "hxyfront-62008:clearance:v1";

/** 预置数据：三段节目、三个离场口、三区人数 */
export function createPresetState(): ShowState {
  return {
    exits: [
      { id: "exit-east", name: "东离场口", widthM: 6, open: true },
      { id: "exit-west", name: "西离场口", widthM: 4, open: true },
      { id: "exit-south", name: "南离场口", widthM: 3, open: true },
    ],
    zones: [
      { id: "zone-a", name: "A区·北岸看台", population: 1800, exitIds: ["exit-east"] },
      { id: "zone-b", name: "B区·中央广场", population: 2400, exitIds: ["exit-west", "exit-south"] },
      { id: "zone-c", name: "C区·近景围档", population: 1500, exitIds: ["exit-south"] },
    ],
    segments: [
      { id: "seg-1", name: "第一段 · 开场迎宾", plannedIgnitionSec: 1200, durationSec: 300, zoneIds: ["zone-a"] },
      { id: "seg-2", name: "第二段 · 高空礼花", plannedIgnitionSec: 1800, durationSec: 420, zoneIds: ["zone-b"] },
      { id: "seg-3", name: "第三段 · 尾声齐鸣", plannedIgnitionSec: 2500, durationSec: 360, zoneIds: ["zone-b", "zone-c"] },
    ],
  };
}

export function loadState(): ShowState {
  try {
    if (typeof localStorage === "undefined") return createPresetState();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createPresetState();
    return sanitize(JSON.parse(raw));
  } catch {
    return createPresetState();
  }
}

export function saveState(state: ShowState): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用（隐私模式/配额满）时静默降级，页面照常工作
  }
}

/** 清除本地数据并返回预置数据 */
export function resetState(): ShowState {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上，静默降级
  }
  return createPresetState();
}

function toExit(raw: unknown): ExitGate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  const widthM = Number(r.widthM);
  if (!Number.isFinite(widthM) || widthM < 0) return null;
  return { id: r.id, name: r.name, widthM, open: r.open !== false };
}

function toZone(raw: unknown): Zone | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  const population = Number(r.population);
  if (!Number.isFinite(population) || population < 0) return null;
  const exitIds = Array.isArray(r.exitIds)
    ? r.exitIds.filter((id): id is string => typeof id === "string")
    : [];
  return { id: r.id, name: r.name, population: Math.round(population), exitIds };
}

function toSegment(raw: unknown): Segment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  const plannedIgnitionSec = Number(r.plannedIgnitionSec);
  const durationSec = Number(r.durationSec);
  if (!Number.isFinite(plannedIgnitionSec) || plannedIgnitionSec < 0) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const zoneIds = Array.isArray(r.zoneIds)
    ? r.zoneIds.filter((id): id is string => typeof id === "string")
    : [];
  return { id: r.id, name: r.name, plannedIgnitionSec, durationSec, zoneIds };
}

/** 校验本地读出的数据；结构损坏时回退预置，引用悬空时剔除 */
function sanitize(raw: unknown): ShowState {
  const preset = createPresetState();
  if (!raw || typeof raw !== "object") return preset;
  const r = raw as Record<string, unknown>;
  const exits = Array.isArray(r.exits)
    ? r.exits.map(toExit).filter((x): x is ExitGate => x !== null)
    : [];
  const zones = Array.isArray(r.zones)
    ? r.zones.map(toZone).filter((x): x is Zone => x !== null)
    : [];
  const segments = Array.isArray(r.segments)
    ? r.segments.map(toSegment).filter((x): x is Segment => x !== null)
    : [];
  if (exits.length === 0 || zones.length === 0 || segments.length === 0) return preset;
  const exitIds = new Set(exits.map((e) => e.id));
  const zoneIds = new Set(zones.map((z) => z.id));
  return {
    exits,
    zones: zones.map((z) => ({ ...z, exitIds: z.exitIds.filter((id) => exitIds.has(id)) })),
    segments: segments.map((s) => ({ ...s, zoneIds: s.zoneIds.filter((id) => zoneIds.has(id)) })),
  };
}
