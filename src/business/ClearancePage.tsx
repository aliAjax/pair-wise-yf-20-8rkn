// 页面业务层：编排放行台 —— 配置编辑、核算结果、时间轴与预警区展示。
import { useEffect, useMemo, useState } from "react";
import {
  CLEAR_BUFFER_SECONDS,
  evaluatePlan,
  formatTime,
  segmentSignature,
  type PlanData,
  type SegmentVerdict,
} from "./clearance";
import { loadPlan, resetPlan, savePlan } from "./storage";

const TRACK_END_PADDING = 45; // 时间轴右端留白（秒）
const RULER_STEP = 60;

function parseTime(text: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function TimeInput({ seconds, onChange }: { seconds: number; onChange: (s: number) => void }) {
  const [text, setText] = useState(formatTime(seconds));

  useEffect(() => {
    setText(formatTime(seconds));
  }, [seconds]);

  return (
    <input
      value={text}
      aria-label="点火时刻 分:秒"
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const parsed = parseTime(next);
        if (parsed !== null) onChange(parsed);
      }}
      onBlur={() => setText(formatTime(seconds))}
      className={parseTime(text) === null ? "input-error" : ""}
      placeholder="mm:ss"
    />
  );
}

function ClearancePage() {
  const [plan, setPlan] = useState<PlanData>(() => loadPlan());
  const verdict = useMemo(() => evaluatePlan(plan), [plan]);

  useEffect(() => {
    savePlan(plan);
  }, [plan]);

  const updateExit = (id: string, patch: Partial<PlanData["exits"][number]>) =>
    setPlan((p) => ({
      ...p,
      exits: p.exits.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }));

  const updateZone = (id: string, patch: Partial<PlanData["zones"][number]>) =>
    setPlan((p) => ({
      ...p,
      zones: p.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)),
    }));

  const updateSegment = (id: string, patch: Partial<PlanData["segments"][number]>) =>
    setPlan((p) => ({
      ...p,
      segments: p.segments.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  const adoptIgnition = (segId: string, igniteAt: number) =>
    setPlan((p) => {
      const seg = p.segments.find((s) => s.id === segId);
      if (!seg) return p;
      return {
        ...p,
        overrides: {
          ...p.overrides,
          [segId]: { igniteAt, signature: segmentSignature(seg, p) },
        },
      };
    });

  const staleCount = verdict.segments.filter((v) => v.overrideStale).length;
  const trackEnd = useMemo(() => {
    const latest = Math.max(
      ...verdict.segments.flatMap((v) => [v.plannedIgnite, v.clearanceEnd, v.igniteAt])
    );
    return Math.ceil((latest + TRACK_END_PADDING) / RULER_STEP) * RULER_STEP;
  }, [verdict]);

  const pct = (sec: number) => `${(Math.min(sec, trackEnd) / trackEnd) * 100}%`;
  const ticks = Array.from({ length: Math.round(trackEnd / RULER_STEP) + 1 }, (_, i) => i * RULER_STEP);

  return (
    <main className="app clearance-app">
      <header className="hero">
        <p>FIRE CONTROL · 安保放行核算</p>
        <h1>烟花编排 · 清场放行台</h1>
        <span>
          编排只给点火时刻，安保按各区人数与离场口宽度核算清场：通行能力 120 人 / 分钟 / 米，另加 {CLEAR_BUFFER_SECONDS}{" "}
          秒清场缓冲。清场未结束即挡住点火，离场口关停或调整宽度会使已放行段落失效重算。
        </span>
      </header>

      <section className="metrics">
        <article>
          <small>节目段落</small>
          <strong>{verdict.segments.length}</strong>
        </article>
        <article className="metric-ok">
          <small>已放行</small>
          <strong>{verdict.clearedCount}</strong>
        </article>
        <article className="metric-bad">
          <small>挡住</small>
          <strong>{verdict.blockedCount}</strong>
        </article>
        <article className="metric-warn">
          <small>失效重算</small>
          <strong>{staleCount}</strong>
        </article>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>时间轴编排</p>
            <h2>清场过程与点火判定</h2>
          </div>
          <button className="ghost" onClick={() => setPlan(resetPlan())}>
            恢复预置数据
          </button>
        </div>

        <div className="timeline-legend">
          <span><i className="lg evac" />疏散耗时</span>
          <span><i className="lg buffer" />{CLEAR_BUFFER_SECONDS}秒清场缓冲</span>
          <span><i className="lg planned" />编排点火</span>
          <span><i className="lg actual" />实际点火</span>
          <span><i className="lg block" />挡住 / 最早可点火</span>
        </div>

        <div className="timeline">
          <div className="tl-row tl-ruler">
            <div className="tl-label" />
            <div className="tl-track">
              {ticks.map((t) => (
                <span key={t} className="tick" style={{ left: pct(t) }}>
                  {formatTime(t)}
                </span>
              ))}
            </div>
          </div>

          {verdict.segments.map((v) => (
            <div className="tl-row" key={v.segId}>
              <div className="tl-label">
                <b>{v.name}</b>
                <span className={`badge badge-${v.status}`}>
                  {v.status === "ok" ? "准予点火" : v.status === "adjusted" ? "已调整放行" : "挡住"}
                </span>
              </div>
              <div className="tl-track">
                {/* 疏散主体 */}
                <div
                  className={`bar bar-evac ${v.hardBlocked ? "bar-dead" : ""}`}
                  style={{ left: pct(v.evacStart), width: pct(v.evacSeconds) }}
                  title={`疏散 ${formatTime(v.evacStart)} → ${formatTime(v.evacStart + v.evacSeconds)}（${v.evacSeconds}秒）`}
                />
                {/* 清场缓冲 */}
                {!v.hardBlocked && (
                  <div
                    className="bar bar-buffer"
                    style={{
                      left: pct(v.evacStart + v.evacSeconds),
                      width: pct(CLEAR_BUFFER_SECONDS),
                    }}
                    title={`清场缓冲 ${CLEAR_BUFFER_SECONDS}秒，至 ${formatTime(v.clearanceEnd)}`}
                  />
                )}

                {/* 编排点火 */}
                <div className="marker marker-planned" style={{ left: pct(v.plannedIgnite) }}>
                  <i />
                  <em>{formatTime(v.plannedIgnite)}</em>
                </div>

                {/* 实际 / 最早点火 */}
                {v.blocked ? (
                  <div className="marker marker-block" style={{ left: pct(v.hardBlocked ? v.plannedIgnite : v.earliestIgnite) }}>
                    <i>⛔</i>
                    {!v.hardBlocked && <em>最早 {formatTime(v.earliestIgnite)}</em>}
                  </div>
                ) : (
                  <div className="marker marker-actual" style={{ left: pct(v.igniteAt) }}>
                    <i>🔥</i>
                    <em>{formatTime(v.igniteAt)}</em>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel warning-panel">
        <div className="heading">
          <div>
            <p>安保预警区</p>
            <h2>阻塞原因与放行操作</h2>
          </div>
        </div>
        <div className="warning-list">
          {verdict.segments.filter((v) => v.blocked || v.overrideStale).length === 0 && (
            <p className="all-clear">全部段落清场先于点火完成，可按编排执行。</p>
          )}
          {verdict.segments
            .filter((v) => v.blocked || v.overrideStale)
            .map((v) => (
              <article key={v.segId} className={`warning-card ${v.hardBlocked ? "level-hard" : "level-block"}`}>
                <div className="warning-main">
                  <h3>{v.name}</h3>
                  <ul>
                    {v.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
                <div className="warning-actions">
                  {!v.hardBlocked && v.blocked && (
                    <button
                      className="primary"
                      onClick={() => adoptIgnition(v.segId, Math.max(v.plannedIgnite, v.earliestIgnite))}
                    >
                      采用最早可点火 {formatTime(Math.max(v.plannedIgnite, v.earliestIgnite))}
                    </button>
                  )}
                  {!v.blocked && v.overrideStale && (
                    <button className="primary" onClick={() => adoptIgnition(v.segId, v.igniteAt)}>
                      以 {formatTime(v.igniteAt)} 重新确认放行
                    </button>
                  )}
                  {v.hardBlocked && <span className="hard-note">请先恢复或增设离场口</span>}
                </div>
              </article>
            ))}
        </div>
      </section>

      <section className="workspace clearance-workspace">
        <section className="panel">
          <div className="heading">
            <div>
              <p>预置节目</p>
              <h2>三段节目</h2>
            </div>
          </div>
          <div className="config-list">
            {plan.segments.map((seg, i) => {
              const v = verdict.segments.find((item) => item.segId === seg.id);
              return (
                <div className="config-row" key={seg.id}>
                  <div className="config-head">
                    <b>{i + 1}. {seg.name}</b>
                    <TimeInput seconds={seg.plannedIgnite} onChange={(s) => updateSegment(seg.id, { plannedIgnite: s })} />
                  </div>
                  <p>疏散区域：{plan.zones.filter((z) => seg.zoneIds.includes(z.id)).map((z) => z.name).join("、")}</p>
                  {v && <SegmentCalc v={v} />}
                </div>
              );
            })}
          </div>
        </section>

        <div className="side-stack">
          <section className="panel">
            <div className="heading">
              <div>
                <p>通行能力</p>
                <h2>三个离场口</h2>
              </div>
            </div>
            <div className="config-list">
              {plan.exits.map((exit) => (
                <div className={`config-row exit-row ${exit.enabled ? "" : "disabled-row"}`} key={exit.id}>
                  <label className="switch-label">
                    <input
                      type="checkbox"
                      checked={exit.enabled}
                      onChange={(e) => updateExit(exit.id, { enabled: e.target.checked })}
                    />
                    <b>{exit.name}</b>
                  </label>
                  <label className="num-label">
                    <span>宽度（米）</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={exit.width}
                      onChange={(e) => updateExit(exit.id, { width: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </label>
                  <small>能力 {Math.round(exit.width * 120)} 人/分钟{exit.enabled ? "" : " · 已关停"}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="heading">
              <div>
                <p>疏散对象</p>
                <h2>各区人数</h2>
              </div>
            </div>
            <div className="config-list">
              {plan.zones.map((zone) => (
                <div className="config-row" key={zone.id}>
                  <div className="config-head">
                    <b>{zone.name}</b>
                    <label className="num-label inline">
                      <span>人数</span>
                      <input
                        type="number"
                        min={0}
                        step={10}
                        value={zone.population}
                        onChange={(e) => updateZone(zone.id, { population: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                      />
                    </label>
                  </div>
                  <p>离场口：{zone.exitIds.map((id) => plan.exits.find((e) => e.id === id)?.name).filter(Boolean).join("、")}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function SegmentCalc({ v }: { v: SegmentVerdict }) {
  return (
    <div className="seg-calc">
      <div className="zone-calc-head">
        <span>区域</span>
        <span>人数</span>
        <span>能力(人/秒)</span>
        <span>疏散(秒)</span>
      </div>
      {v.zones.map((z) => (
        <div className={`zone-calc ${z.dead ? "dead" : ""}`} key={z.zoneId}>
          <span>{z.zoneName}</span>
          <span>{z.population}</span>
          <span>{z.dead ? "—" : z.capacity.toFixed(1)}</span>
          <span>{z.dead ? "无法疏散" : z.evacSeconds}</span>
        </div>
      ))}
      <p className="calc-line">
        清场结束 {formatTime(v.clearanceEnd)} ·{" "}
        {v.blocked ? "点火被挡住" : `实际点火 ${formatTime(v.igniteAt)}`}
      </p>
    </div>
  );
}

export default ClearancePage;
