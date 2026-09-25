// 放行核算 · 判定逻辑
// 纯函数模块：不依赖 React 与浏览器 API，可独立测试。
// 规则：离场口按宽度每分钟每米通行 120 人，疏散完成后另加 120 秒清场缓冲；
// 每段的疏散自上一段燃放结束开始（首段自放行开始），清场结束晚于计划点火即阻塞。

/** 离场口通行能力：每分钟每米宽度可通行人数 */
export const FLOW_PER_METER_PER_MIN = 120;
/** 清场缓冲：疏散完成后额外预留的秒数 */
export const CLEAR_BUFFER_SEC = 120;
/** 时间轴零点（放行/清场开始）对应的当天秒数，用于 HH:MM:SS 显示与录入 */
export const SHOW_BASE_SEC = 18 * 3600 + 40 * 60; // 18:40:00
/** 阻塞判定容差（秒），吸收浮点误差 */
const BLOCK_TOLERANCE_SEC = 0.5;

export interface ExitGate {
  id: string;
  name: string;
  widthM: number; // 有效宽度（米）
  open: boolean; // 关停 = false
}

export interface Zone {
  id: string;
  name: string;
  population: number; // 该区人数
  exitIds: string[]; // 疏散可用的离场口
}

export interface Segment {
  id: string;
  name: string;
  plannedIgnitionSec: number; // 计划点火时刻（相对放行开始的偏移秒）
  durationSec: number; // 燃放持续时长（秒）
  zoneIds: string[]; // 点火前必须完成清场的区域
}

export interface ShowState {
  exits: ExitGate[];
  zones: Zone[];
  segments: Segment[];
}

export type SegmentStatus = "ok" | "blocked" | "invalid";

export interface ZoneClearance {
  zoneId: string;
  zoneName: string;
  population: number;
  capacityPerMin: number; // 该区可用离场口合计通行能力（人/分钟）
  evacSec: number; // 纯疏散耗时（秒），无可用离场口时为 Infinity
  finishSec: number; // 清场结束时刻（偏移秒，含缓冲）
  note: string; // 该区域核算说明
}

export interface SegmentJudgment {
  segmentId: string;
  evacStartSec: number; // 疏散开始时刻（上一段燃放结束；首段为 0）
  clearEndSec: number; // 全部相关区域清场结束时刻（取最大）
  earliestIgnitionSec: number; // 最早可点火时刻 = clearEndSec
  effectiveIgnitionSec: number; // 实际点火时刻 = max(计划, 最早)
  delaySec: number; // 阻塞时长（秒）
  status: SegmentStatus;
  reasons: string[]; // 阻塞/失效原因
  zones: ZoneClearance[];
}

export interface ShowJudgment {
  segments: SegmentJudgment[];
  blockedCount: number;
  invalidCount: number;
}

/** 区域当前可用离场口的合计通行能力（人/分钟），关停的离场口不计 */
export function zoneCapacityPerMin(state: ShowState, zone: Zone): number {
  return zone.exitIds.reduce((sum, id) => {
    const exit = state.exits.find((e) => e.id === id);
    return exit && exit.open ? sum + exit.widthM * FLOW_PER_METER_PER_MIN : sum;
  }, 0);
}

/** 离场口关停/调宽会影响哪些段落（经区域关联），用于失效重算提示 */
export function segmentsAffectedByExit(state: ShowState, exitId: string): string[] {
  const zoneIds = new Set(
    state.zones.filter((z) => z.exitIds.includes(exitId)).map((z) => z.id)
  );
  return state.segments
    .filter((s) => s.zoneIds.some((id) => zoneIds.has(id)))
    .map((s) => s.id);
}

/** 区域人数/疏散口调整会影响哪些段落 */
export function segmentsAffectedByZone(state: ShowState, zoneId: string): string[] {
  return state.segments.filter((s) => s.zoneIds.includes(zoneId)).map((s) => s.id);
}

/** 对整场演出逐段核算，阻塞段会顺延下游段的疏散起点（级联重算） */
export function judgeShow(state: ShowState): ShowJudgment {
  const zoneById = new Map(state.zones.map((z) => [z.id, z]));
  const segments: SegmentJudgment[] = [];
  let prevEndSec = 0; // 上一段实际燃放结束时刻

  state.segments.forEach((seg, index) => {
    const evacStartSec = index === 0 ? 0 : prevEndSec;
    const reasons: string[] = [];

    // 上游段落清场失败 → 本段疏散无法开始，直接失效并向下游传播
    if (!Number.isFinite(evacStartSec)) {
      reasons.push("上游段落清场失败，本段疏散无法开始");
      segments.push({
        segmentId: seg.id,
        evacStartSec,
        clearEndSec: Infinity,
        earliestIgnitionSec: Infinity,
        effectiveIgnitionSec: Infinity,
        delaySec: Infinity,
        status: "invalid",
        reasons,
        zones: [],
      });
      prevEndSec = Infinity;
      return;
    }

    const zones: ZoneClearance[] = seg.zoneIds.map((zoneId) => {
      const zone = zoneById.get(zoneId);
      if (!zone) {
        return {
          zoneId,
          zoneName: zoneId,
          population: 0,
          capacityPerMin: 0,
          evacSec: Infinity,
          finishSec: Infinity,
          note: `区域 ${zoneId} 配置缺失`,
        };
      }
      const capacityPerMin = zoneCapacityPerMin(state, zone);
      if (capacityPerMin <= 0) {
        return {
          zoneId,
          zoneName: zone.name,
          population: zone.population,
          capacityPerMin: 0,
          evacSec: Infinity,
          finishSec: Infinity,
          note: `${zone.name} 无可用离场口（全部关停或未指定），${zone.population}人无法疏散`,
        };
      }
      const evacSec = (zone.population / capacityPerMin) * 60;
      const finishSec = evacStartSec + evacSec + CLEAR_BUFFER_SEC;
      return {
        zoneId,
        zoneName: zone.name,
        population: zone.population,
        capacityPerMin,
        evacSec,
        finishSec,
        note: `${zone.name} ${zone.population}人 ÷ ${capacityPerMin}人/分钟 ≈ ${formatDuration(evacSec)}，加缓冲${formatDuration(CLEAR_BUFFER_SEC)}，${formatClock(finishSec)}完成`,
      };
    });

    const hasInvalidZone = zones.some((z) => !Number.isFinite(z.finishSec));
    const clearEndSec =
      zones.length === 0
        ? evacStartSec
        : zones.reduce((max, z) => Math.max(max, z.finishSec), 0);
    const earliestIgnitionSec = clearEndSec;
    const effectiveIgnitionSec = Math.max(seg.plannedIgnitionSec, earliestIgnitionSec);
    const delaySec = Math.max(0, earliestIgnitionSec - seg.plannedIgnitionSec);

    let status: SegmentStatus = "ok";
    if (hasInvalidZone) status = "invalid";
    else if (delaySec > BLOCK_TOLERANCE_SEC) status = "blocked";

    if (hasInvalidZone) {
      zones
        .filter((z) => !Number.isFinite(z.finishSec))
        .forEach((z) => reasons.push(z.note));
      reasons.push("清场无法完成：请开放离场口或调整该区域疏散口配置");
    } else if (status === "blocked") {
      if (zones.length === 0) {
        reasons.push(
          `上一段燃放结束 ${formatClock(evacStartSec)} 已晚于计划点火 ${formatClock(seg.plannedIgnitionSec)}`
        );
      } else {
        const slowest = zones.reduce((a, b) => (b.finishSec > a.finishSec ? b : a));
        reasons.push(
          `清场结束 ${formatClock(clearEndSec)} 晚于计划点火 ${formatClock(seg.plannedIgnitionSec)}，阻塞 ${formatDuration(delaySec)}`
        );
        reasons.push(
          `瓶颈区域 ${slowest.zoneName}：${slowest.population}人，可用通行能力 ${slowest.capacityPerMin}人/分钟`
        );
      }
    }

    segments.push({
      segmentId: seg.id,
      evacStartSec,
      clearEndSec,
      earliestIgnitionSec,
      effectiveIgnitionSec,
      delaySec,
      status,
      reasons,
      zones,
    });
    prevEndSec = effectiveIgnitionSec + seg.durationSec;
  });

  return {
    segments,
    blockedCount: segments.filter((s) => s.status === "blocked").length,
    invalidCount: segments.filter((s) => s.status === "invalid").length,
  };
}

/** 偏移秒 → 当天时刻 HH:MM:SS（以 SHOW_BASE_SEC 为零点） */
export function formatClock(offsetSec: number): string {
  if (!Number.isFinite(offsetSec)) return "—";
  const total =
    (((SHOW_BASE_SEC + Math.round(offsetSec)) % 86400) + 86400) % 86400;
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, "0")).join(":");
}

/** 秒 → “2分30秒” 风格时长 */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest}秒`;
  return rest === 0 ? `${m}分钟` : `${m}分${String(rest).padStart(2, "0")}秒`;
}

/** 解析 HH:MM 或 HH:MM:SS 时刻录入，返回相对放行开始的偏移秒；非法返回 null */
export function parseClockInput(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] ?? 0);
  if (mm > 59 || ss > 59) return null;
  const offset = hh * 3600 + mm * 60 + ss - SHOW_BASE_SEC;
  return offset >= 0 ? offset : null;
}
