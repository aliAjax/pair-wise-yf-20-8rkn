import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  CLEAR_BUFFER_SEC,
  FLOW_PER_METER_PER_MIN,
  formatClock,
  formatDuration,
  judgeShow,
  parseClockInput,
  segmentsAffectedByExit,
  segmentsAffectedByZone,
  zoneCapacityPerMin,
  type ExitGate,
  type Segment,
  type ShowState,
  type Zone,
} from "./judgment";
import { loadState, resetState, saveState } from "./storage";

const STATUS_TEXT = { ok: "可按计划点火", blocked: "阻塞", invalid: "失效" } as const;

function App() {
  const [state, setState] = useState<ShowState>(loadState);
  const [notice, setNotice] = useState("");
  const judgment = useMemo(() => judgeShow(state), [state]);

  // 任何变更即写入浏览器本地存储
  useEffect(() => {
    saveState(state);
  }, [state]);

  const segName = (id: string) => state.segments.find((s) => s.id === id)?.name ?? id;
  const zoneName = (id: string) => state.zones.find((z) => z.id === id)?.name ?? id;

  const announce = (label: string, affectedIds: string[]) => {
    setNotice(
      affectedIds.length
        ? `${label} → 相关段落（${affectedIds.map(segName).join("、")}）判定失效，已重算`
        : `${label} → 无关联段落，全场已重算`
    );
  };

  // —— 离场口：关停 / 调宽，触发相关段落失效重算 ——
  const toggleExit = (exit: ExitGate) => {
    const next: ShowState = {
      ...state,
      exits: state.exits.map((e) => (e.id === exit.id ? { ...e, open: !e.open } : e)),
    };
    setState(next);
    announce(`${exit.name} ${exit.open ? "已关停" : "恢复开放"}`, segmentsAffectedByExit(next, exit.id));
  };

  const updateWidth = (exit: ExitGate, widthM: number) => {
    const next: ShowState = {
      ...state,
      exits: state.exits.map((e) => (e.id === exit.id ? { ...e, widthM } : e)),
    };
    setState(next);
    announce(`${exit.name} 宽度 ${exit.widthM}m → ${widthM}m`, segmentsAffectedByExit(next, exit.id));
  };

  // —— 区域：人数 / 疏散口调整 ——
  const updatePopulation = (zone: Zone, population: number) => {
    const next: ShowState = {
      ...state,
      zones: state.zones.map((z) => (z.id === zone.id ? { ...z, population } : z)),
    };
    setState(next);
    announce(`${zone.name} 人数 ${zone.population} → ${population}`, segmentsAffectedByZone(next, zone.id));
  };

  const toggleZoneExit = (zone: Zone, exitId: string) => {
    const exitIds = zone.exitIds.includes(exitId)
      ? zone.exitIds.filter((id) => id !== exitId)
      : [...zone.exitIds, exitId];
    const next: ShowState = {
      ...state,
      zones: state.zones.map((z) => (z.id === zone.id ? { ...z, exitIds } : z)),
    };
    setState(next);
    announce(`${zone.name} 疏散口调整`, segmentsAffectedByZone(next, zone.id));
  };

  // —— 段落：计划点火 / 持续时长 ——
  const updateSegment = (segmentId: string, patch: Partial<Segment>) => {
    setState({
      ...state,
      segments: state.segments.map((s) => (s.id === segmentId ? { ...s, ...patch } : s)),
    });
  };

  const commitIgnition = (seg: Segment, raw: string, input: HTMLInputElement) => {
    const offset = parseClockInput(raw);
    if (offset === null) {
      input.value = formatClock(seg.plannedIgnitionSec);
      setNotice(`时间格式应为 HH:MM:SS，且不早于 ${formatClock(0)}（放行开始）`);
      return;
    }
    if (offset !== seg.plannedIgnitionSec) {
      updateSegment(seg.id, { plannedIgnitionSec: offset });
    }
  };

  const handleReset = () => {
    setState(resetState());
    setNotice("已恢复预置数据：三段节目、三个离场口、三区人数");
  };

  const totalCapacity = state.exits.reduce(
    (sum, e) => sum + (e.open ? e.widthM * FLOW_PER_METER_PER_MIN : 0),
    0
  );
  const openExits = state.exits.filter((e) => e.open).length;
  const problems = judgment.segments
    .map((j, i) => ({ j, seg: state.segments[i] }))
    .filter((x) => x.j.status !== "ok");

  // 时间轴量程：覆盖计划/实际燃放结束与清场结束，末尾留白
  const spanSec = useMemo(() => {
    let max = 600;
    judgment.segments.forEach((j, i) => {
      const seg = state.segments[i];
      max = Math.max(max, seg.plannedIgnitionSec + seg.durationSec);
      if (Number.isFinite(j.effectiveIgnitionSec)) {
        max = Math.max(max, j.effectiveIgnitionSec + seg.durationSec);
      }
      if (Number.isFinite(j.clearEndSec)) max = Math.max(max, j.clearEndSec);
    });
    return max + 180;
  }, [judgment, state]);

  const pct = (sec: number) => `${Math.min(100, Math.max(0, (sec / spanSec) * 100))}%`;
  const ticks: number[] = [];
  for (let t = 0; t <= spanSec; t += 300) ticks.push(t);

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62008 · 放行核算 · Port 62008</p>
        <h1>燃放编排 · 放行核算</h1>
        <span>
          预置三段节目、三个离场口与各区人数。离场口按宽度每分钟每米通行 {FLOW_PER_METER_PER_MIN} 人，
          清场另加 {CLEAR_BUFFER_SEC} 秒缓冲；清场结束晚于下一段计划点火即挡下并给出最早可点火时刻。
          离场口关停或调宽会让相关段落失效重算，全部数据保存在浏览器本地。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>总通行能力（人/分钟）</small>
          <strong>{totalCapacity}</strong>
        </article>
        <article>
          <small>开放离场口</small>
          <strong>{openExits}/{state.exits.length}</strong>
        </article>
        <article>
          <small>阻塞段落</small>
          <strong>{judgment.blockedCount}</strong>
        </article>
        <article>
          <small>失效段落</small>
          <strong>{judgment.invalidCount}</strong>
        </article>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>预警区</p>
            <h2>阻塞与失效</h2>
          </div>
          <button onClick={handleReset}>恢复预置</button>
        </div>
        {notice && <p className="notice">{notice}</p>}
        {problems.length === 0 ? (
          <p className="ok-line">✓ 三段节目清场均可在计划点火前完成，无阻塞。</p>
        ) : (
          <div className="alert-list">
            {problems.map(({ j, seg }) => (
              <article key={seg.id} className={`alert-card ${j.status}`}>
                <header>
                  <strong>{seg.name}</strong>
                  <span className={`badge ${j.status}`}>
                    {j.status === "blocked" ? `阻塞 ${formatDuration(j.delaySec)}` : "失效"}
                  </span>
                </header>
                <ul>
                  {j.reasons.map((r, k) => (
                    <li key={k}>{r}</li>
                  ))}
                </ul>
                <p className="earliest">
                  最早可点火时刻：<b>{formatClock(j.earliestIgnitionSec)}</b>
                  {j.status === "blocked" && `（计划 ${formatClock(seg.plannedIgnitionSec)}）`}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>时间轴</p>
            <h2>疏散清场 × 点火窗口</h2>
          </div>
          <div className="legend">
            <span><i className="l-evac" />疏散清场</span>
            <span><i className="l-buffer" />缓冲{CLEAR_BUFFER_SEC}秒</span>
            <span><i className="l-fire" />燃放窗口</span>
            <span><i className="l-planned" />计划点火</span>
          </div>
        </div>
        <div className="timeline">
          <div className="tl-ruler">
            <span />
            <div className="tl-ruler-track">
              {ticks.map((t) => (
                <span key={t} className="tick" style={{ left: pct(t) }}>{formatClock(t)}</span>
              ))}
            </div>
          </div>
          {state.segments.map((seg, i) => {
            const j = judgment.segments[i];
            const clearFinite = Number.isFinite(j.clearEndSec);
            const fireFinite = Number.isFinite(j.effectiveIgnitionSec);
            return (
              <div className="tl-row" key={seg.id}>
                <div className="tl-label">
                  <strong>{seg.name}</strong>
                  <span className={`badge ${j.status}`}>{STATUS_TEXT[j.status]}</span>
                </div>
                <div className="tl-track">
                  {clearFinite && j.clearEndSec > j.evacStartSec && (
                    <div
                      className="tl-evac"
                      style={{ left: pct(j.evacStartSec), width: pct(j.clearEndSec - j.evacStartSec) }}
                      title={`疏散清场 ${formatClock(j.evacStartSec)} → ${formatClock(j.clearEndSec)}`}
                    />
                  )}
                  {!clearFinite && Number.isFinite(j.evacStartSec) && (
                    <div
                      className="tl-evac infinite"
                      style={{ left: pct(j.evacStartSec), width: `${100 - (j.evacStartSec / spanSec) * 100}%` }}
                      title="清场无法完成"
                    />
                  )}
                  {clearFinite && j.clearEndSec > j.evacStartSec && (
                    <div
                      className="tl-buffer"
                      style={{
                        left: pct(Math.max(j.evacStartSec, j.clearEndSec - CLEAR_BUFFER_SEC)),
                        width: pct(Math.min(CLEAR_BUFFER_SEC, j.clearEndSec - j.evacStartSec)),
                      }}
                      title={`清场缓冲 ${CLEAR_BUFFER_SEC}秒`}
                    />
                  )}
                  <div
                    className={`tl-planned${j.status !== "ok" ? " late" : ""}`}
                    style={{ left: pct(seg.plannedIgnitionSec) }}
                    title={`计划点火 ${formatClock(seg.plannedIgnitionSec)}`}
                  />
                  {fireFinite ? (
                    <div
                      className="tl-fire"
                      style={{ left: pct(j.effectiveIgnitionSec), width: pct(seg.durationSec) }}
                      title={`燃放窗口 ${formatClock(j.effectiveIgnitionSec)} 起 ${formatDuration(seg.durationSec)}`}
                    >
                      <span>{formatClock(j.effectiveIgnitionSec)}</span>
                    </div>
                  ) : (
                    <span className="tl-dead">清场无法完成，点火被挡下</span>
                  )}
                </div>
                {j.status !== "ok" && (
                  <div className="tl-reason">
                    {j.reasons.map((r, k) => (
                      <p key={k}>{r}</p>
                    ))}
                    {fireFinite && j.status === "blocked" && (
                      <p>最早可点火 {formatClock(j.earliestIgnitionSec)}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid-3">
        <section className="panel">
          <div className="heading">
            <div>
              <p>离场口</p>
              <h2>通行能力</h2>
            </div>
          </div>
          <div className="stack">
            {state.exits.map((exit) => (
              <div key={exit.id} className={`exit-card${exit.open ? "" : " closed"}`}>
                <div className="exit-head">
                  <strong>{exit.name}</strong>
                  <button
                    className={exit.open ? "danger" : "primary"}
                    onClick={() => toggleExit(exit)}
                  >
                    {exit.open ? "关停" : "恢复开放"}
                  </button>
                </div>
                <label>
                  <span>有效宽度（米）</span>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={exit.widthM}
                    disabled={!exit.open}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v) && v >= 0 && v !== exit.widthM) updateWidth(exit, v);
                    }}
                  />
                </label>
                <p className={`cap${exit.open && exit.widthM > 0 ? "" : " zero"}`}>
                  通行能力 {exit.open ? exit.widthM * FLOW_PER_METER_PER_MIN : 0} 人/分钟
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="heading">
            <div>
              <p>观众区</p>
              <h2>各区人数</h2>
            </div>
          </div>
          <div className="stack">
            {state.zones.map((zone) => {
              const cap = zoneCapacityPerMin(state, zone);
              return (
                <div key={zone.id} className="zone-card">
                  <strong>{zone.name}</strong>
                  <label>
                    <span>人数</span>
                    <input
                      type="number"
                      min="0"
                      step="50"
                      value={zone.population}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (Number.isFinite(v) && v >= 0 && v !== zone.population) {
                          updatePopulation(zone, v);
                        }
                      }}
                    />
                  </label>
                  <div className="check-row">
                    {state.exits.map((exit) => (
                      <label key={exit.id} className="check">
                        <input
                          type="checkbox"
                          checked={zone.exitIds.includes(exit.id)}
                          onChange={() => toggleZoneExit(zone, exit.id)}
                        />
                        {exit.name}
                      </label>
                    ))}
                  </div>
                  <p className={`cap${cap > 0 ? "" : " zero"}`}>
                    {cap > 0 ? `合计通行能力 ${cap} 人/分钟` : "无可用离场口"}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <div className="heading">
            <div>
              <p>节目段落</p>
              <h2>段落与点火</h2>
            </div>
          </div>
          <div className="stack">
            {state.segments.map((seg, i) => {
              const j = judgment.segments[i];
              return (
                <article key={seg.id} className={`seg-card ${j.status}`}>
                  <div className="seg-head">
                    <strong>{seg.name}</strong>
                    <span className={`badge ${j.status}`}>{STATUS_TEXT[j.status]}</span>
                  </div>
                  <div className="seg-fields">
                    <label>
                      <span>计划点火（HH:MM:SS）</span>
                      <input
                        key={`${seg.id}-${seg.plannedIgnitionSec}`}
                        defaultValue={formatClock(seg.plannedIgnitionSec)}
                        onBlur={(e) => commitIgnition(seg, e.target.value, e.target)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </label>
                    <label>
                      <span>持续时长（秒）</span>
                      <input
                        type="number"
                        min="10"
                        step="10"
                        value={seg.durationSec}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (Number.isFinite(v) && v > 0 && v !== seg.durationSec) {
                            updateSegment(seg.id, { durationSec: v });
                          }
                        }}
                      />
                    </label>
                  </div>
                  <p className="zones-line">需清场：{seg.zoneIds.map(zoneName).join("、") || "无"}</p>
                  <p className="zones-line">
                    疏散窗口 {formatClock(j.evacStartSec)} → {formatClock(j.clearEndSec)}
                    ，最早可点火 <b>{formatClock(j.earliestIgnitionSec)}</b>
                  </p>
                  {j.zones.map((z) => (
                    <p key={z.zoneId} className="znote">{z.note}</p>
                  ))}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
