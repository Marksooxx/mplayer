// 真实 mpv 事件流回放：逐帧(144Hz)驱动 旧算法(§6.30 版本，逐行移植) 与 新 playheadClock，
// 以 audio-pts 分段线性拟合出的"正在响的位置"为真值，统计光标误差并对新算法做阈值断言。
//
// 注意：真值来自同一串 audio-pts —— 这里证明的是"跟上了 mpv 的音频时钟"，不是屏幕与
// 耳朵之间的绝对误差（事件链 / 上屏 / 声卡延迟都不在其中）。
// 用法：node --experimental-strip-types --no-warnings dev-tools/sync/clock/replay.test.ts [模拟事件链延迟ms]
import { readFileSync } from "node:fs";
import { createPlayheadClock, type ClockInput } from "../../../src/lib/playheadClock.ts";

type Ev = { t: number; ev?: string; name?: string; v?: number | null; act?: string };
const DATA = new URL("./data/mpv-events/", import.meta.url);
const LAT = Number(process.argv[2] ?? "0");

// ---------------- 旧算法（§6.30 版本 useCursorAnimation.tick 逐行移植，只作对比） ----------------
function createOldClock() {
  let displayed: number | null = null, lastTickTime = 0, lastSeenPosition = -Infinity, wasPlaying = false;
  let pauseFreezeUntil = 0, playStartedAt = 0, forceNextSnap = false;
  const agedTarget = (s: ClockInput, now: number, playing: boolean) => {
    if (!playing) return s.position;
    const base = Math.max(s.positionObservedAt, playStartedAt);
    return s.position + Math.min(Math.max(0, (now - base) / 1000), 1.5) * s.speed;
  };
  return {
    forceSnap(_now: number, _a?: boolean, _t?: number | null) { forceNextSnap = true; pauseFreezeUntil = 0; },
    tick(s: ClockInput, now: number) {
      const playing = s.playing;
      if (!wasPlaying && playing) playStartedAt = now;
      if (displayed === null || now - lastTickTime > 1000) {
        displayed = agedTarget(s, now, playing); lastSeenPosition = s.position; lastTickTime = now; pauseFreezeUntil = 0;
      } else {
        const dt = (now - lastTickTime) / 1000; lastTickTime = now;
        if (wasPlaying && !playing) pauseFreezeUntil = now + 280;
        if (!(!playing && now < pauseFreezeUntil) && s.position !== lastSeenPosition) {
          if (forceNextSnap) { displayed = agedTarget(s, now, playing); forceNextSnap = false; }
          lastSeenPosition = s.position;
        }
        if (playing) {
          displayed += dt * s.speed;
          const target = agedTarget(s, now, playing); const err = target - displayed;
          if (Math.abs(err) > 0.3) displayed = target;
          else { const m = 0.1 * s.speed * dt; displayed += Math.max(-m, Math.min(m, err * (dt / 0.4))); }
          if (s.duration > 0 && displayed > s.duration) displayed = s.duration;
          if (displayed < 0) displayed = 0;
        }
      }
      wasPlaying = playing;
      return displayed ?? 0;
    },
  };
}

// ---------------- 场景 ----------------
// windows: [名称, 起, 止, 基准('start'=文件起点 | 'restart'=首个 playback-restart | 'act'=用户动作), 新算法 p95|e| 上限 ms]
type Win = [string, number, number, "start" | "restart" | "act", number];
interface Scenario { log: string; duration: number; loop?: boolean; windows: Win[]; note?: string }
const scenarios: Record<string, Scenario> = {
  "2s wav 单曲循环": { log: "loopev.json", duration: 2.0, loop: true, windows: [["0.5s 后全程", 0.5, 99, "start", 5]] },
  "wav 稳态": { log: "wav_wasapi.json", duration: 12, windows: [["0.3–6s", 0.3, 6, "start", 5]] },
  "mp3 稳态": { log: "mp3_wasapi.json", duration: 12, windows: [["0.3–6s", 0.3, 6, "start", 5]] },
  "mp4 24fps": { log: "mp4_wasapi.json", duration: 12, windows: [["0.3–6s", 0.3, 6, "start", 5]] },
  "mp4 60fps": { log: "mp4_60.json", duration: 8, windows: [["0.3–6s", 0.3, 6, "start", 5]] },
  "wav 起播": { log: "wav_wasapi.json", duration: 12, windows: [["开播后 0–0.6s", 0, 0.6, "restart", 5]] },
  "wav seek→7.25": { log: "wav_seek.json", duration: 12, windows: [["seek 后 0–0.6s", 0, 0.6, "act", 8], ["seek 后 0.6–3s", 0.6, 3, "act", 3]] },
  // mp4 seek 后首 0.6s：mpv 音频时钟起步阶段增长慢于实时，而真值是整段直线拟合，残差主要是真值模型误差
  "mp4 seek→7.25": { log: "mp4_seek.json", duration: 12, windows: [["seek 后 0–0.6s", 0, 0.6, "act", 40], ["seek 后 0.6–3s", 0.6, 3, "act", 8]] },
  "wav 变速 1→1.5": { log: "wav_speed.json", duration: 12, windows: [["变速后 0–1.5s", 0, 1.5, "act", 5]] },
  "mp4 变速 1→1.5": { log: "mp4_speed.json", duration: 12, windows: [["变速后 0–1.5s", 0, 1.5, "act", 15]] },
  "wav 暂停/恢复": { log: "wav_pause.json", duration: 12, windows: [["恢复后 0–1.5s", 0, 1.5, "act", 5]] },
  "mp4 暂停/恢复": { log: "mp4_pause.json", duration: 12, windows: [["恢复后 0–1.5s", 0, 1.5, "act", 15]] },
};

function truthFn(evs: Ev[], sc: Scenario, speedAt: (t: number) => number) {
  const seekAct = evs.find((e) => e.act && /^seek/.test(e.act));
  // 有效 audio-pts 样本（循环尾巴负值 +duration），按连续性分段做线性拟合
  const pts = evs.filter((e) => e.name === "audio-pts" && e.v != null).map((e) => {
    let v = e.v as number; if (sc.loop && v < 0) v += sc.duration; return { t: e.t, v };
  });
  const segs: { t0: number; t1: number; a: number; b: number }[] = [];
  let cur: { t: number; v: number }[] = [];
  const flush = () => {
    if (cur.length >= 3) {
      const n = cur.length, mt = cur.reduce((s, p) => s + p.t, 0) / n, mv = cur.reduce((s, p) => s + p.v, 0) / n;
      let num = 0, den = 0; for (const p of cur) { num += (p.t - mt) * (p.v - mv); den += (p.t - mt) ** 2; }
      const a = num / den; segs.push({ t0: cur[0].t, t1: cur[n - 1].t, a, b: mv - a * mt });
    }
    cur = [];
  };
  for (const p of pts) {
    const prev = cur[cur.length - 1];
    if (prev && Math.abs(p.v - (prev.v + (p.t - prev.t) * speedAt(prev.t))) > 0.03) flush();
    cur.push(p);
  }
  flush();
  return (t: number): number | null => {
    // seek 之后、新音频段之前：音频未开始，"正在响的位置"= 落点
    if (seekAct && t >= seekAct.t) {
      const next = segs.find((s) => s.t0 > seekAct.t);
      if (next && t < next.t0) {
        const anchor = evs.find((e) => e.name === "time-pos" && e.t > seekAct.t && e.v != null)?.v as number;
        return Math.max(anchor, next.a * t + next.b);
      }
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (t >= s.t0) {
        const next = segs[i + 1];
        if (seekAct && s.t1 < seekAct.t && t >= seekAct.t) return null;
        // 段内有定义；循环模式下段后一直在响（尾巴 → 回绕）直到下一段开始
        if (t <= s.t1 + 0.12 || (sc.loop && (!next || t < next.t0))) {
          let v = s.a * t + s.b; if (sc.loop) v = ((v % sc.duration) + sc.duration) % sc.duration; return v;
        }
        return null;
      }
    }
    return null;
  };
}

let failures = 0;
for (const [label, sc] of Object.entries(scenarios)) {
  const evs: Ev[] = JSON.parse(readFileSync(new URL(sc.log, DATA), "utf8"));
  const acts = evs.filter((e) => e.act);
  const actT = acts.find((a) => /seek|speed|resume/.test(a.act!))?.t ?? 0;
  const speedAct = acts.find((a) => /^speed/.test(a.act!));
  const newSpeed = speedAct ? Number(speedAct.act!.replace("speed", "")) : 1;
  const speedAt = (t: number) => (speedAct && t >= speedAct.t ? newSpeed : 1);
  const truth = truthFn(evs, sc, speedAt);
  const lat = LAT / 1000;
  const restart = evs.find((e) => e.ev === "playback-restart")?.t ?? 0;

  for (const algo of ["old", "new"] as const) {
    const clk = algo === "old" ? createOldClock() : createPlayheadClock();
    const st: ClockInput = {
      playing: false, position: 0, positionObservedAt: 0, audioPts: null, audioPtsObservedAt: 0, restartAt: 0,
      hasAudio: true, speed: 1, duration: sc.duration, dragPosition: null, loopFile: !!sc.loop,
    };
    let isPlaying = true, fileLoaded = false, i = 0;
    const errs: Record<string, number[]> = {}; for (const w of sc.windows) errs[w[0]] = [];
    const tEnd = evs[evs.length - 1].t;
    for (let t = 0.001; t < tEnd; t += 1 / 144) {
      while (i < evs.length && evs[i].t + (evs[i].name ? lat : 0) <= t) {
        const e = evs[i++]; const at = (e.t + (e.name ? lat : 0)) * 1000;
        if (e.act) {
          // 与 App 一致：seek 带目标提示(用于识别落点)
          if (/^seek/.test(e.act)) clk.forceSnap(at, true, Number(e.act.replace("seek", "")));
          if (/^speed/.test(e.act)) st.speed = newSpeed;
        } else if (e.ev === "file-loaded") fileLoaded = true;
        else if (e.ev === "playback-restart") st.restartAt = at;
        else if (e.ev === "start-file") { fileLoaded = false; clk.forceSnap(at, true, 0); }
        else if (e.name === "time-pos") { st.position = e.v ?? 0; st.positionObservedAt = at; }
        else if (e.name === "audio-pts") { st.audioPts = e.v ?? null; st.audioPtsObservedAt = at; }
        else if (e.name === "pause") isPlaying = !e.v;
      }
      st.playing = isPlaying && fileLoaded;
      const d = clk.tick({ ...st }, t * 1000);
      if (!st.playing) continue;
      let tr = truth(t);
      if (tr === null && label === "wav 起播" && t < restart + 0.2) tr = 0; // 音频开始前的"正在响位置"= 0
      if (tr === null) continue;
      let e = d - tr; if (sc.loop) { const D = sc.duration; e = (((e + D / 2) % D) + D) % D - D / 2; }
      for (const [name, a, b, base] of sc.windows) {
        const x = base === "act" ? t - actT : base === "restart" ? t - restart : t;
        if (x >= a && x < b) errs[name].push(e * 1000);
      }
    }
    for (const [name, , , , limit] of sc.windows) {
      const arr = errs[name];
      if (!arr.length) { console.log(`${algo === "new" ? "FAIL" : "    "}  ${label} ${name} ${algo}: 无样本`); if (algo === "new") failures++; continue; }
      const abs = arr.map(Math.abs).sort((x, y) => x - y);
      const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
      const p95 = abs[Math.floor(abs.length * 0.95)], mx = abs[abs.length - 1];
      const stats = `平均 ${mean.toFixed(1).padStart(6)}ms  p95|e| ${p95.toFixed(1).padStart(6)}  max|e| ${mx.toFixed(1).padStart(6)}`;
      if (algo === "old") console.log(`      ${label} · ${name} · 旧: ${stats}`);
      else {
        const ok = LAT > 0 || p95 <= limit;
        if (!ok) failures++;
        console.log(`${ok ? "PASS" : "FAIL"}  ${label} · ${name} · 新: ${stats}  (上限 p95 ${limit}ms)`);
      }
    }
  }
}
if (LAT > 0) console.log(`\n模拟 ${LAT}ms 事件链延迟：仅输出指标，不断言（稳态误差应 ≈ −${LAT}ms）`);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures ? 1 : 0;
