// 放行核算判定层：纯函数，不接触 DOM / 存储。
// 规则：
// 1. 离场口通行能力 = 宽度(米) × 120 人/分钟（即每秒每米 2 人）。
// 2. 区域所需疏散秒数 = ceil(人数 / 区域可用离场口通行能力之和)。
// 3. 段落清场结束时刻 = 疏散开始 + 段内最慢区域疏散秒数 + 120 秒清场缓冲。
// 4. 疏散开始：首段为 00:00，其余为上一段的实际点火时刻；
//    上一段仍被挡住时暂按其编排时刻顺延，放行调整后会自动重算下游。
// 5. 清场结束晚于本段编排点火时刻即挡住，并给出最早可点火时刻 = 清场结束时刻。
// 6. 离场口关停 / 宽度调整、区域人数或点火计划变化会让已采用的放行时刻失效。

export const FLOW_PER_METER_PER_MINUTE = 120;
const FLOW_PER_METER_PER_SECOND = FLOW_PER_METER_PER_MINUTE / 60;
export const CLEAR_BUFFER_SECONDS = 120;

export interface ExitDef {
  id: string;
  name: string;
  width: number; // 米
  enabled: boolean; // 关停后不计通行能力
}

export interface ZoneDef {
  id: string;
  name: string;
  population: number;
  exitIds: string[];
}

export interface SegmentDef {
  id: string;
  name: string;
  plannedIgnite: number; // 编排点火时刻（秒）
  zoneIds: string[];
}

export interface IgniteOverride {
  igniteAt: number; // 已采用的放行点火时刻
  signature: string; // 采用时刻对应的参数签名
}

export interface PlanData {
  exits: ExitDef[];
  zones: ZoneDef[];
  segments: SegmentDef[];
  overrides: Record<string, IgniteOverride>;
}

export type SegmentStatus = "ok" | "blocked" | "adjusted";

export interface ZoneClearance {
  zoneId: string;
  zoneName: string;
  population: number;
  exitNames: string[];
  capacity: number; // 人/秒
  evacSeconds: number;
  dead: boolean; // 没有任何可用离场口（关停或未关联）
}

export interface SegmentVerdict {
  segId: string;
  index: number;
  name: string;
  plannedIgnite: number;
  evacStart: number;
  evacSeconds: number;
  clearanceEnd: number;
  earliestIgnite: number;
  igniteAt: number; // 实际生效点火时刻（未放行时仍显示编排时刻）
  status: SegmentStatus;
  blocked: boolean;
  hardBlocked: boolean; // 存在无法疏散的区域（离场口关停等）
  overrideStale: boolean; // 已采用的放行时刻因参数变化失效
  zones: ZoneClearance[];
  reasons: string[];
}

export interface PlanVerdict {
  segments: SegmentVerdict[];
  blockedCount: number;
  clearedCount: number;
}

export function createPresetPlan(): PlanData {
  return {
    exits: [
      { id: "e-east", name: "东门", width: 3.0, enabled: true },
      { id: "e-north", name: "北门", width: 2.0, enabled: true },
      { id: "e-west", name: "西侧通道", width: 1.5, enabled: true },
    ],
    zones: [
      { id: "z-a", name: "观礼A区", population: 420, exitIds: ["e-east", "e-north"] },
      { id: "z-b", name: "草坪站立区", population: 1200, exitIds: ["e-east", "e-west"] },
      { id: "z-c", name: "近景VIP区", population: 300, exitIds: ["e-north"] },
    ],
    segments: [
      { id: "s-intro", name: "开场序章", plannedIgnite: 165, zoneIds: ["z-a"] },
      { id: "s-main", name: "主段齐射", plannedIgnite: 240, zoneIds: ["z-b"] },
      { id: "s-finale", name: "终场高潮", plannedIgnite: 450, zoneIds: ["z-c"] },
    ],
    overrides: {},
  };
}

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// 参数签名：只覆盖影响本段清场耗时的输入（点火计划、人数、离场口宽度/关停）。
export function segmentSignature(seg: SegmentDef, data: PlanData): string {
  const exitMap = new Map(data.exits.map((e) => [e.id, e]));
  const zoneMap = new Map(data.zones.map((z) => [z.id, z]));

  const zones = [...seg.zoneIds]
    .map((id) => zoneMap.get(id))
    .filter((z): z is ZoneDef => Boolean(z))
    .sort((a, b) => a.id.localeCompare(b.id));

  const zonePart = zones
    .map((z) => `${z.id}:${z.population}:${[...z.exitIds].sort().join("~")}`)
    .join("|");

  const exitIds = new Set(zones.flatMap((z) => z.exitIds));
  const exitPart = [...exitIds]
    .sort()
    .map((id) => {
      const exit = exitMap.get(id);
      return exit ? `${id}:${exit.width}:${exit.enabled ? 1 : 0}` : `${id}:missing`;
    })
    .join("|");

  return `plan=${seg.plannedIgnite};zones=${zonePart};exits=${exitPart}`;
}

function evaluateZone(
  zone: ZoneDef,
  exitMap: Map<string, ExitDef>
): ZoneClearance {
  const linked = zone.exitIds.map((id) => exitMap.get(id)).filter((e): e is ExitDef => Boolean(e));
  const open = linked.filter((e) => e.enabled && e.width > 0);
  const capacity = open.reduce((sum, e) => sum + e.width * FLOW_PER_METER_PER_SECOND, 0);
  const dead = open.length === 0 || capacity <= 0;
  return {
    zoneId: zone.id,
    zoneName: zone.name,
    population: zone.population,
    exitNames: linked.map((e) => `${e.name}${e.enabled ? "" : "（已关停）"}`),
    capacity,
    evacSeconds: dead || zone.population <= 0 ? 0 : Math.ceil(zone.population / capacity),
    dead,
  };
}

export function evaluatePlan(data: PlanData): PlanVerdict {
  const exitMap = new Map(data.exits.map((e) => [e.id, e]));
  const zoneMap = new Map(data.zones.map((z) => [z.id, z]));
  const ordered = [...data.segments].sort((a, b) => a.plannedIgnite - b.plannedIgnite);

  const verdicts: SegmentVerdict[] = [];

  ordered.forEach((seg, index) => {
    const prev = index > 0 ? verdicts[index - 1] : undefined;
    // 上一段被挡住时暂按其编排点火时刻顺延，放行后整链自动重算。
    const evacStart = prev ? (prev.blocked ? prev.plannedIgnite : prev.igniteAt) : 0;

    const zoneResults = [...seg.zoneIds]
      .map((id) => zoneMap.get(id))
      .filter((z): z is ZoneDef => Boolean(z))
      .map((z) => evaluateZone(z, exitMap));

    const deadZones = zoneResults.filter((z) => z.dead);
    const evacSeconds = zoneResults.reduce((max, z) => Math.max(max, z.evacSeconds), 0);
    const clearanceEnd = evacStart + evacSeconds + CLEAR_BUFFER_SECONDS;
    const earliestIgnite = clearanceEnd;

    const reasons: string[] = [];
    for (const z of deadZones) {
      const linked = z.exitNames.length ? z.exitNames.join("、") : "未关联离场口";
      reasons.push(`${z.zoneName}（${z.population}人）无可用离场口：${linked}，人员无法疏散`);
    }

    const signature = segmentSignature(seg, data);
    const saved = data.overrides[seg.id];
    const overrideStale = Boolean(saved && saved.signature !== signature);
    const activeOverride = saved && !overrideStale ? saved : null;

    const hardBlocked = deadZones.length > 0;
    let blocked = hardBlocked;
    let status: SegmentStatus = "ok";
    let igniteAt = seg.plannedIgnite;

    if (hardBlocked) {
      status = "blocked";
    } else if (activeOverride) {
      if (activeOverride.igniteAt >= clearanceEnd) {
        status = "adjusted";
        igniteAt = Math.max(seg.plannedIgnite, activeOverride.igniteAt);
      } else {
        blocked = true;
        status = "blocked";
        reasons.push(
          `已采用的放行时刻 ${formatTime(activeOverride.igniteAt)} 仍早于清场结束 ${formatTime(
            clearanceEnd
          )}（上游段落延后导致），最早可点火 ${formatTime(earliestIgnite)}`
        );
      }
    } else if (clearanceEnd > seg.plannedIgnite) {
      blocked = true;
      status = "blocked";
      reasons.push(
        `清场 ${formatTime(clearanceEnd)} 才结束，晚于编排点火 ${formatTime(
          seg.plannedIgnite
        )}，最早可点火 ${formatTime(earliestIgnite)}`
      );
    }

    if (overrideStale) {
      reasons.push("上次采用的放行时刻已失效（离场口关停/宽度、区域人数或点火计划有变更），需重新核算");
    }

    verdicts.push({
      segId: seg.id,
      index,
      name: seg.name,
      plannedIgnite: seg.plannedIgnite,
      evacStart,
      evacSeconds,
      clearanceEnd,
      earliestIgnite,
      igniteAt,
      status,
      blocked,
      hardBlocked,
      overrideStale,
      zones: zoneResults,
      reasons,
    });
  });

  return {
    segments: verdicts,
    blockedCount: verdicts.filter((v) => v.blocked).length,
    clearedCount: verdicts.filter((v) => !v.blocked).length,
  };
}
