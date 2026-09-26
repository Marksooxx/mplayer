// §6.22 历史雷区 + op 状态机边界 + 评审反例（codex / workflow）的合成事件测试
import { createPlayheadClock, type ClockInput } from "../../../src/lib/playheadClock.ts";

type Step = {
  at: number; pos?: number; ap?: number | null; playing?: boolean; force?: boolean | "step" | { t: number };
  hasAudio?: boolean | null; hasVideo?: boolean | null; speed?: number; restart?: boolean; drag?: number | null; eof?: boolean;
};
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

/** 以 144Hz 推进；steps 按时间注入 store 变化；gaps: [from,to) 内不 tick（模拟后台） */
function run(steps: Step[], until: number, base: Partial<ClockInput> = {}, gaps: [number, number][] = []) {
  const clk = createPlayheadClock();
  const st: ClockInput = {
    playing: true, position: 0, positionObservedAt: 0, audioPts: null, audioPtsObservedAt: 0, restartAt: 0,
    hasAudio: true, speed: 1, duration: 60, dragPosition: null, loopFile: false, ...base,
  };
  const out: [number, number, string][] = [];
  let i = 0;
  const sorted = [...steps].sort((a, b) => a.at - b.at);
  for (let t = 0; t <= until; t += 1000 / 144) {
    while (i < sorted.length && sorted[i].at <= t) {
      const s = sorted[i++];
      if (s.force !== undefined) clk.forceSnap(s.at, s.force !== "step", typeof s.force === "object" ? s.force.t : null);
      if (s.pos !== undefined) { st.position = s.pos; st.positionObservedAt = s.at; }
      if (s.ap !== undefined) { st.audioPts = s.ap; st.audioPtsObservedAt = s.at; }
      if (s.playing !== undefined) st.playing = s.playing;
      if (s.hasVideo !== undefined) st.hasVideo = s.hasVideo;
      if (s.eof !== undefined) st.eof = s.eof;
      if (s.hasAudio !== undefined) st.hasAudio = s.hasAudio;
      if (s.speed !== undefined) st.speed = s.speed;
      if (s.restart) st.restartAt = s.at;
      if (s.drag !== undefined) st.dragPosition = s.drag;
    }
    if (gaps.some(([a, b]) => t >= a && t < b)) continue;
    out.push([t, clk.tick({ ...st }, t), clk.debug().src]);
  }
  return out;
}
const at = (out: [number, number, string][], t: number) => out.filter(([x]) => x <= t).at(-1)![1];
const tickAt = (out: [number, number, string][], t: number) => out.filter(([x]) => x <= t).at(-1)![0];
const backMovesWhile = (out: [number, number, string][], from: number, to: number) =>
  out.filter(([t]) => t > from && t < to).some(([, d], k, arr) => k > 0 && d < arr[k - 1][1] - 1e-9);

/** 稳态播放事件：每 60ms 一条 audio-pts + time-pos（真值 = t/1000；视频 time-pos 超前 40ms） */
function steady(from: number, to: number, withTp = true, off = 0): Step[] {
  const s: Step[] = [];
  for (let t = from; t < to; t += 60) {
    s.push({ at: t, ap: t / 1000 + off });
    if (withTp) s.push({ at: t + 0.1, pos: t / 1000 + off + 0.04 });
  }
  return s;
}
/** seek 后的新音频段：在 startAt 开始出声，位置从 target 起 */
function after(target: number, startAt: number, to: number): Step[] {
  const s: Step[] = [];
  for (let t = startAt + 10; t < to; t += 60) { s.push({ at: t, ap: target + (t - startAt) / 1000 }); s.push({ at: t + 0.1, pos: target + (t - startAt) / 1000 }); }
  return s;
}

// ── A. §6.22：暂停不瞬移 / 不后退 ──
{
  const out = run([...steady(0, 2000), { at: 2000, playing: false }, { at: 2050, pos: 2.09 }, { at: 2600, pos: 1.9996 }], 3000);
  // 取暂停生效后的第一帧作为参照：其后所有帧必须完全相同
  const paused = out.filter(([t]) => t > 2001);
  const ref = paused[0][1];
  check("A1 暂停后光标不后退、不前跳(尾报 +50ms、回退值都不采用)", paused.every(([, d]) => Math.abs(d - ref) < 1e-9), `ref=${ref.toFixed(4)}`);
  const tLast = tickAt(out, 1990);
  check("A2 暂停前光标跟随 audio-pts（不跟超前的 time-pos）", Math.abs(at(out, 1990) - tLast / 1000) < 0.003, `displayed=${at(out, 1990).toFixed(4)} audio=${(tLast / 1000).toFixed(4)}`);
}
{
  // 暂停中窗口进后台 1.5s（rAF 停），期间 mpv 报了一条尾值；恢复后光标保持
  const out = run([...steady(0, 2000), { at: 2000, playing: false }, { at: 2400, pos: 2.09 }], 4000, {}, [[2100, 3600]]);
  check("A3 暂停中后台 >1s 恢复：光标保持原值", Math.abs(at(out, 3990) - at(out, 2099)) < 1e-9, `${at(out, 2099).toFixed(4)} → ${at(out, 3990).toFixed(4)}`);
}

// ── B. 暂停中 seek ──
{
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1500, force: true }, { at: 1900, pos: 5.0 }, { at: 1905, restart: true }], 2500);
  check("B1 暂停中慢 seek（400ms）→ 落点", Math.abs(at(out, 2500) - 5.0) < 1e-9, `final=${at(out, 2500)}`);
}
{
  // codex 反例：旧回报 0.97 先到，真实落点 400ms 后才到
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1500, force: true }, { at: 1502, pos: 0.97 }, { at: 1900, pos: 5.0 }, { at: 1901, restart: true }], 2500);
  check("B2 暂停中 seek：旧值先到 + 真落点晚 400ms → 停在落点", Math.abs(at(out, 2500) - 5.0) < 1e-9, `final=${at(out, 2500)}`);
}
{
  // 纯音频暂停 seek：restart 后约 50ms 报出 AO 缓冲虚值（ao=null 实录 0.6262），不得采用
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1500, force: true }, { at: 1501, pos: 0.81 }, { at: 1502, restart: true }, { at: 1552, pos: 0.6262 }, { at: 1552.1, ap: 0.6262 }], 2500);
  check("B3 暂停 seek 完成后的虚值不采用", Math.abs(at(out, 2500) - 0.81) < 1e-9, `final=${at(out, 2500)}`);
}
{
  // 拖动进度条松手：落点回报落在 200ms 乐观窗内（拖动分支中），松手后必须补上
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1400, drag: 0.81 }, { at: 1500, force: true }, { at: 1540, pos: 0.7917 }, { at: 1541, restart: true }, { at: 1700, drag: null }], 2200);
  check("B4 暂停中拖动松手 → 光标落到 mpv 实际落点", Math.abs(at(out, 2200) - 0.7917) < 1e-9, `final=${at(out, 2200)}`);
}

// ── C. 帧步进（mpv frame-step：pause=0 → ~30ms → pause=1 + time-pos + audio-pts）──
{
  const steps: Step[] = [...steady(0, 1000), { at: 1000, playing: false }];
  let tp = 1.0, t0 = 1500;
  for (let k = 0; k < 5; k++, t0 += 400) {
    tp += 1 / 24;
    steps.push({ at: t0, force: "step" }, { at: t0 + 1, playing: true }, { at: t0 + 31, playing: false }, { at: t0 + 31.1, pos: tp }, { at: t0 + 31.2, ap: tp - 0.05 });
  }
  const out = run(steps, 3600);
  const vals = [1, 2, 3, 4, 5].map((k) => at(out, 1500 + 400 * k - 10));
  const exp = [1, 2, 3, 4, 5].map((k) => 1.0 + k / 24);
  check("C1 暂停中连按 5 次帧步进：每次落到帧 pts", vals.every((v, k) => Math.abs(v - exp[k]) < 1e-9), vals.map((v) => v.toFixed(4)).join(" "));
}
{
  // 同批事件乱序：audio-pts 先于 pause=1 / time-pos 到达，且跨过 rAF 边界
  const steps: Step[] = [...steady(0, 1000), { at: 1000, playing: false }, { at: 1500, force: "step" }, { at: 1501, playing: true },
    { at: 1531, ap: 1.0 }, { at: 1540, playing: false }, { at: 1540.1, pos: 1.0417 }];
  const out = run(steps, 1900);
  check("C2 帧步进同批乱序（audio 先到）仍落到帧 pts", Math.abs(at(out, 1900) - 1.0417) < 1e-9, `final=${at(out, 1900).toFixed(4)}`);
}
{
  // 帧步进后恢复播放：audio-pts 滞后约 1 帧 → 不得倒退
  const steps: Step[] = [...steady(0, 1000), { at: 1000, playing: false }, { at: 1500, force: "step" }, { at: 1501, playing: true },
    { at: 1531, playing: false }, { at: 1531.1, pos: 1.0417 }, { at: 1531.2, ap: 0.99 }, { at: 2000, playing: true }, ...after(0.99, 2030, 3000)];
  const out = run(steps, 3000);
  check("C3 帧步进后恢复播放不倒退", !backMovesWhile(out, 1999, 3000));
  const tc = tickAt(out, 2990);
  // 不后退保护的代价：初始领先约 1 帧(51ms)，以 slew(τ=0.4s、≤10%) 收敛，约 1s 后 <12ms
  check("C3' 恢复后约 1s 内收敛到 <12ms", Math.abs(at(out, 2990) - (0.99 + (tc - 2030) / 1000)) < 0.012, `err=${((at(out, 2990) - (0.99 + (tc - 2030) / 1000)) * 1000).toFixed(1)}ms`);
}

// ── D. 播放中 seek ──
{
  const out = run([...steady(0, 2000), { at: 2000, force: true }, { at: 2001, pos: 7.25 }, { at: 2001.1, ap: null }, { at: 2002, restart: true }, ...after(7.25, 2030, 4000)], 4000);
  const hold = out.filter(([t]) => t > 2003 && t < 2039).map(([, d]) => d);
  check("D1 seek 后音频开始前钉在落点", hold.every((d) => Math.abs(d - 7.25) < 1e-9), `hold∈[${Math.min(...hold)},${Math.max(...hold)}]`);
  const e = Math.max(...out.filter(([t]) => t > 2100).map(([t, d]) => Math.abs(d - (7.25 + (t - 2030) / 1000))));
  check("D2 seek 后跟随新音频时钟", e < 0.003, `max|err|=${(e * 1000).toFixed(2)}ms`);
  check("D3 seek 后光标不后退", !backMovesWhile(out, 2001, 4000));
}
{
  // codex 反例：落点 7.25 之后，一条操作前在途的旧 audio-pts 1.02 晚到 → 不得跳回
  const out = run([...steady(0, 1000), { at: 1000, force: true }, { at: 1001, pos: 7.25 }, { at: 1003, ap: 1.02 }, { at: 1004, ap: null }, { at: 1005, restart: true }, ...after(7.25, 1030, 2000)], 2000);
  const minAfter = Math.min(...out.filter(([t]) => t > 1002).map(([, d]) => d));
  check("D4 旧 audio-pts 晚到不把光标拽回", minAfter >= 7.25 - 1e-9, `min=${minAfter.toFixed(4)}`);
}
{
  // workflow 反例：小幅 seek（-0.2s）且旧 time-pos/audio-pts 都在操作后到达、restart 之前
  const steps: Step[] = [...steady(0, 2000), { at: 2000, force: true }, { at: 2006, pos: 2.0 }, { at: 2006.1, ap: 1.995 },
    { at: 2012, pos: 1.8 }, { at: 2012.1, ap: null }, { at: 2013, restart: true }, ...after(1.8, 2040, 4000)];
  const out = run(steps, 4000);
  const e = Math.max(...out.filter(([t]) => t > 2150).map(([t, d]) => Math.abs(d - (1.8 + (t - 2040) / 1000))));
  check("D5 小幅 seek + 旧锚点/旧音频：150ms 后误差 <5ms", e < 0.005, `max|err|=${(e * 1000).toFixed(1)}ms`);
}
{
  // 单曲循环中 seek 恰好到末尾：钉住期间不被取模成 0
  const out = run([...steady(0, 1000), { at: 1000, force: true }, { at: 1001, pos: 2.0 }, { at: 1001.1, ap: null }], 1040, { loopFile: true, duration: 2.0 });
  check("D6 循环模式 seek 到末尾：钉住时显示 2.0", Math.abs(at(out, 1030) - 2.0) < 1e-9, `displayed=${at(out, 1030)}`);
}

// ── E. 其它 ──
{
  const steps: Step[] = [];
  for (let t = 0; t < 3000; t += 41.7) steps.push({ at: t, pos: t / 1000 });
  steps.push({ at: 3000, force: true }, { at: 3001, restart: true });
  for (let t = 3001; t < 5000; t += 41.7) steps.push({ at: t, pos: 10 + (t - 3001) / 1000 });
  const out = run(steps, 5000, { hasAudio: false });
  const e = Math.max(...out.filter(([t]) => t > 3300).map(([t, d]) => Math.abs(d - (10 + (t - 3001) / 1000))));
  check("E1 无音轨：seek 后跟随 time-pos", e < 0.05, `max|err|=${(e * 1000).toFixed(1)}ms`);
}
{
  const steps: Step[] = [{ at: 0, force: true }, { at: 10, pos: 0 }, { at: 11, restart: true }];
  for (let t = 50; t < 4000; t += 50) steps.push({ at: t, pos: (t - 40) / 1000 });
  const out = run(steps, 4000);
  check("E2 audio-pts 永不出现：hold 超时后继续走", at(out, 4000) > 3.5, `final=${at(out, 4000).toFixed(3)}`);
}
{
  // 单曲循环：回绕时 time-pos 提前归零冻结、audio-pts 先 null 后负值 —— 光标连续回绕
  const D = 2.0; const steps: Step[] = [];
  for (let t = 0; t < 1650; t += 50) { steps.push({ at: t, ap: t / 1000 }); steps.push({ at: t + 0.1, pos: t / 1000 }); }
  steps.push({ at: 1653, pos: 0 }, { at: 1653.1, ap: null }, { at: 1653.5, restart: true });
  for (let t = 1703; t < 2000; t += 50) steps.push({ at: t, ap: t / 1000 - D });
  for (let t = 2050; t < 3500; t += 50) { steps.push({ at: t, ap: t / 1000 - D }); steps.push({ at: t + 0.1, pos: t / 1000 - D }); }
  const out = run(steps, 3500, { loopFile: true, duration: D });
  const e = Math.max(...out.filter(([t]) => t > 300).map(([t, d]) => { let x = d - ((t / 1000) % D); x = (((x + D / 2) % D) + D) % D - D / 2; return Math.abs(x); }));
  check("E3 单曲循环回绕连续", e < 0.004, `max|err|=${(e * 1000).toFixed(2)}ms`);
}
{
  const steps: Step[] = [...steady(0, 1000), { at: 1000, force: true }, { at: 1001, pos: 3.0 }, { at: 1002, ap: null, hasAudio: false }, { at: 1003, restart: true }];
  for (let t = 1040; t < 2500; t += 40) steps.push({ at: t, pos: 3.0 + (t - 1020) / 1000 });
  const out = run(steps, 2500);
  const e = Math.abs(at(out, 2500) - (3.0 + (2500 - 1020) / 1000));
  check("E4 关闭音轨后退回 time-pos", e < 0.03, `err=${(e * 1000).toFixed(1)}ms`);
}
{
  // audio 事件停更 3s，只有 1Hz poll 补 time-pos：不得出现锯齿倒退
  const steps: Step[] = [...steady(0, 2000, true, 0)];
  for (let t = 3000; t <= 5000; t += 1000) steps.push({ at: t, pos: t / 1000 });
  const out = run(steps, 5000);
  check("E5 audio 停更 + poll：无倒退锯齿", !backMovesWhile(out, 2000, 5000));
  const t5 = tickAt(out, 4990);
  check("E5' audio 停更 + poll：光标仍跟得上", Math.abs(at(out, 4990) - t5 / 1000) < 0.05, `err=${((at(out, 4990) - t5 / 1000) * 1000).toFixed(1)}ms`);
}
{
  // 起播：file-loaded 时 time-pos 0.0，音频 25ms 后才开始 → 钉在 0 等
  const steps: Step[] = [{ at: 0, playing: false }, { at: 1, force: true }, { at: 20, playing: true }, { at: 20.5, pos: 0 }, { at: 21, restart: true }, ...after(0, 46, 1000)];
  const out = run(steps, 1000);
  const t9 = tickAt(out, 900);
  check("E6 起播前钉在 0，音频开始后跟随", Math.abs(at(out, 45)) < 1e-9 && Math.abs(at(out, 900) - (t9 - 46) / 1000) < 0.003, `@45=${at(out, 45)} err@${t9.toFixed(0)}=${((at(out, 900) - (t9 - 46) / 1000) * 1000).toFixed(2)}ms`);
}

// ── F. codex 第三轮反例（事件乱序 / 归属） ──
{
  // 暂停：restart 先于真落点到达
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1300, force: true }, { at: 1310, restart: true }, { at: 1320, pos: 5.0 }], 1800);
  check("F1 暂停：restart 先到、落点后到 → 落点", Math.abs(at(out, 1800) - 5.0) < 1e-9, `final=${at(out, 1800)}`);
}
{
  // 播放：落点 7.25 → restart → 操作前产生的旧 audio 1.02 晚到 → 新音频
  const out = run([...steady(0, 1000), { at: 1000, force: true }, { at: 1020, pos: 7.25 }, { at: 1021, ap: null }, { at: 1025, restart: true }, { at: 1030, ap: 1.02 },
    ...after(7.25, 1050, 2000)], 2000);
  const minAfter = Math.min(...out.filter(([t]) => t > 1021).map(([, d]) => d));
  const tt = tickAt(out, 1900);
  check("F2 播放：restart 之后晚到的旧 audio 不把光标拽回", minAfter >= 7.25 - 1e-9, `min=${minAfter.toFixed(4)}`);
  check("F2' 之后跟随新音频时钟", Math.abs(at(out, 1900) - (7.25 + (tt - 1050) / 1000)) < 0.003, `err=${((at(out, 1900) - (7.25 + (tt - 1050) / 1000)) * 1000).toFixed(1)}ms`);
}
{
  // 暂停：连续两次 seek，op1 的 restart 在 op2 登记之后才到，op2 的真落点更晚
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1300, force: true }, { at: 1305, pos: 2.0 }, { at: 1310, force: true },
    { at: 1312, restart: true }, { at: 1330, pos: 7.0 }, { at: 1335, restart: true }], 1800);
  check("F3 暂停：连续两次 seek、前一次的 restart 晚到 → 停在第二次落点", Math.abs(at(out, 1800) - 7.0) < 1e-9, `final=${at(out, 1800)}`);
}
{
  const out = run([...steady(0, 1000), { at: 1000, force: true }, { at: 1005, pos: 2.0 }, { at: 1006, ap: null }, { at: 1010, force: true },
    { at: 1012, restart: true }, { at: 1030, pos: 7.0 }, { at: 1031, ap: null }, { at: 1035, restart: true }, ...after(7.0, 1060, 2500)], 2500);
  const tt = tickAt(out, 2400);
  check("F3' 播放：连续两次 seek → 跟随第二次落点的音频", Math.abs(at(out, 2400) - (7.0 + (tt - 1060) / 1000)) < 0.003, `err=${((at(out, 2400) - (7.0 + (tt - 1060) / 1000)) * 1000).toFixed(1)}ms`);
}
{
  // 暂停：restart 永不到，数秒后出现无关回报 → 不采用
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1300, force: true }, { at: 1305, pos: 5.0 }, { at: 5000, pos: 4.8 }], 5500);
  check("F4 暂停：restart 永不到时不无限跟随无关回报", Math.abs(at(out, 5500) - 5.0) < 1e-9, `final=${at(out, 5500)}`);
}
{
  // 暂停中 seek wav（虚值 0.6262）后立即恢复播放：不回退到虚值
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1500, force: true }, { at: 1501, pos: 0.81 }, { at: 1501.5, ap: null }, { at: 1502, restart: true },
    { at: 1552, pos: 0.6262 }, { at: 1552.1, ap: 0.6262 }, { at: 1600, playing: true }, ...after(0.81, 1620, 2600)], 2600);
  const minAfter = Math.min(...out.filter(([t]) => t > 1502).map(([, d]) => d));
  check("F5 暂停 seek 后立即恢复：不回退到 AO 虚值", minAfter >= 0.81 - 1e-9, `min=${minAfter.toFixed(4)}`);
  const tt = tickAt(out, 2500);
  check("F5' 恢复后跟随音频", Math.abs(at(out, 2500) - (0.81 + (tt - 1620) / 1000)) < 0.003, `err=${((at(out, 2500) - (0.81 + (tt - 1620) / 1000)) * 1000).toFixed(1)}ms`);
}
{
  // 无音轨视频播放中向后 seek：restart 先到、落点后到 → 等到落点前光标不前冲
  const steps: Step[] = [];
  for (let t = 0; t < 1100; t += 41.7) steps.push({ at: t, pos: t / 1000 });
  steps.push({ at: 1100, force: true }, { at: 1102, restart: true }, { at: 1110, pos: 0.8 });
  for (let t = 1150; t < 2000; t += 41.7) steps.push({ at: t, pos: 0.8 + (t - 1110) / 1000 });
  const out = run(steps, 2000, { hasAudio: false });
  const maxHold = Math.max(...out.filter(([t]) => t > 1100 && t < 1109).map(([, d]) => d));
  check("F6 无音轨：restart 先到时等落点，不前冲", maxHold <= at(out, 1099) + 1e-9 && Math.abs(at(out, 1112) - 0.8) < 0.01, `hold≤${maxHold.toFixed(3)} @1112=${at(out, 1112).toFixed(3)}`);
}
{
  // 播放中小幅向后 seek(−0.125s)，旧 audio 恰在 restart 后到达并通过相容性检查 → 0.4s 内必须对齐
  const out = run([...steady(0, 2000), { at: 2000, force: true }, { at: 2003, pos: 1.875 }, { at: 2003.1, ap: null }, { at: 2004, restart: true },
    { at: 2006, ap: 1.998 }, ...after(1.875, 2040, 3000)], 3000);
  const tt = tickAt(out, 2400);
  check("F7 小幅向后 seek + 旧 audio 通过相容检查：0.4s 内已对齐", Math.abs(at(out, 2400) - (1.875 + (tt - 2040) / 1000)) < 0.005, `err=${((at(out, 2400) - (1.875 + (tt - 2040) / 1000)) * 1000).toFixed(1)}ms`);
}

// ── G. codex 第四轮反例（带目标提示的 op） ──
{
  // 大幅 seek：旧 time-pos 先到 → restart → 真落点 → 真音频
  const out = run([...steady(0, 1000), { at: 1000, force: { t: 7.25 } }, { at: 1010, pos: 1.02 }, { at: 1020, restart: true }, { at: 1021, ap: null },
    { at: 1030, pos: 7.25 }, ...after(7.25, 1040, 2000)], 2000);
  const minAfter = Math.min(...out.filter(([t]) => t > 1000).map(([, d]) => d));
  const tt = tickAt(out, 1900);
  check("G1 旧 time-pos 先到不被当落点、之后跟随真音频", minAfter >= 1.0 - 0.01 && Math.abs(at(out, 1900) - (7.25 + (tt - 1040) / 1000)) < 0.003,
    `min=${minAfter.toFixed(3)} err=${((at(out, 1900) - (7.25 + (tt - 1040) / 1000)) * 1000).toFixed(1)}ms`);
  check("G1' 旧位置不被显示为落点", !out.some(([t, d]) => t > 1011 && Math.abs(d - 1.02) < 0.005));
}
{
  // 没有落点时旧 audio 先到
  const out = run([...steady(0, 1000), { at: 1000, force: { t: 7.25 } }, { at: 1020, restart: true }, { at: 1030, ap: 1.02 }, { at: 1040, pos: 7.25 }, { at: 1041, ap: null },
    ...after(7.25, 1060, 2000)], 2000);
  const srcAfterStale = out.filter(([t]) => t > 1031 && t < 1039).map(([, , src]) => src);
  const tt = tickAt(out, 1900);
  check("G2 无落点时旧 audio 不解除钉住", srcAfterStale.every((x) => x === "hold"), `src=${[...new Set(srcAfterStale)]}`);
  check("G2' 真落点到达后跳到 7.25 并跟随", Math.abs(at(out, 1045) - 7.25) < 1e-9 && Math.abs(at(out, 1900) - (7.25 + (tt - 1060) / 1000)) < 0.003, `@1045=${at(out, 1045).toFixed(3)}`);
}
{
  // 合法但"迟到"的音频：首个真实音频 300ms 后才报(7.26)，随后 7.56 → 必须解除
  const steps: Step[] = [...steady(0, 1000), { at: 1000, force: { t: 7.0 } }, { at: 1005, pos: 7.0 }, { at: 1006, ap: null }, { at: 1010, restart: true },
    { at: 1300, ap: 7.26 }, { at: 1600, ap: 7.56 }, { at: 1900, ap: 7.86 }];
  const out = run(steps, 2000);
  check("G3 迟到的合法音频能解除钉住", at(out, 2000) > 7.8, `@2000=${at(out, 2000).toFixed(3)} src=${out.at(-1)![2]}`);
}
{
  // 2s 循环里 seek 到 1.9：下一条合法音频已回绕到 0.02
  const out = run([...steady(0, 1000), { at: 1000, force: { t: 1.9 } }, { at: 1005, pos: 1.9 }, { at: 1006, ap: null }, { at: 1010, restart: true },
    { at: 1130, ap: 0.02 }, { at: 1190, ap: 0.08 }, { at: 1250, ap: 0.14 }], 1300, { loopFile: true, duration: 2.0 });
  check("G3' 循环：回绕后的合法音频能解除钉住", out.at(-1)![2] === "audio" && at(out, 1300) < 0.3, `@1300=${at(out, 1300).toFixed(3)} src=${out.at(-1)![2]}`);
}
{
  // 1.5 倍速：迟到 250ms 的音频已走出 0.375s
  const out = run([...steady(0, 1000), { at: 1000, speed: 1.5 }, { at: 1100, force: { t: 5.0 } }, { at: 1105, pos: 5.0 }, { at: 1106, ap: null }, { at: 1110, restart: true },
    { at: 1360, ap: 5.375 }, { at: 1420, ap: 5.465 }], 1500);
  check("G3'' 1.5 倍速迟到音频能解除钉住", out.at(-1)![2] === "audio", `src=${out.at(-1)![2]} @1500=${at(out, 1500).toFixed(3)}`);
}
{
  // 加载中音轨表未知(hasAudio=null)：restart 后音频 250ms 才出 → 光标钉在 0 等
  const steps: Step[] = [{ at: 0, playing: false, hasAudio: null }, { at: 1, force: { t: 0 } }, { at: 20, playing: true }, { at: 20.5, pos: 0 }, { at: 21, restart: true },
    { at: 150, hasAudio: true }, ...after(0, 271, 1200)];
  const out = run(steps, 1200);
  check("G4 音轨未知时不提前走", Math.max(...out.filter(([t]) => t < 271).map(([, d]) => d)) < 1e-9, `max before audio=${Math.max(...out.filter(([t]) => t < 271).map(([, d]) => d)).toFixed(3)}`);
  const tt = tickAt(out, 1100);
  check("G4' 音频出现后跟随", Math.abs(at(out, 1100) - (tt - 271) / 1000) < 0.003, `err=${((at(out, 1100) - (tt - 271) / 1000) * 1000).toFixed(1)}ms`);
}
{
  // 解除后 audio 停更、退回领先 40ms 的 time-pos：快速对齐窗口不得因 time-pos 前跳
  const steps: Step[] = [...steady(0, 1000), { at: 1000, force: { t: 3.0 } }, { at: 1005, pos: 3.0 }, { at: 1006, ap: null }, { at: 1010, restart: true },
    { at: 1030, ap: 3.0 }];
  for (let t = 1030; t < 2000; t += 42) steps.push({ at: t + 0.1, pos: 3.0 + (t - 1030) / 1000 + 0.04 });
  const out = run(steps, 1600);
  let maxJump = 0;
  for (let k = 1; k < out.length; k++) if (out[k][0] > 1030 && out[k][0] < 1600) maxJump = Math.max(maxJump, out[k][1] - out[k - 1][1]);
  check("G5 快速对齐只用新到的 audio：不因 time-pos 前跳", maxJump < 0.0075 + 0.012, `max step=${(maxJump * 1000).toFixed(1)}ms`);
}
{
  // 暂停：restart → AO 虚值 0.6262 → 真落点 0.81
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1500, force: { t: 0.81 } }, { at: 1502, restart: true }, { at: 1510, pos: 0.6262 }, { at: 1520, pos: 0.81 }], 2000);
  check("G6 暂停：restart→虚值→真落点 → 停在真落点", Math.abs(at(out, 2000) - 0.81) < 1e-9, `final=${at(out, 2000)}`);
}
{
  // 暂停视频：0.81 落点，restart 后真实显示帧 0.8333（相符）→ 采用
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1500, force: { t: 0.81 } }, { at: 1501, pos: 0.81 }, { at: 1502, restart: true }, { at: 1540, pos: 0.8333 }], 2000);
  check("G7 暂停视频 seek：完成后到的真实显示帧也采用", Math.abs(at(out, 2000) - 0.8333) < 1e-9, `final=${at(out, 2000)}`);
}
{
  // 暂停：完成后只有不相符的虚值 → 300ms 后显示目标本身
  const out = run([...steady(0, 1000), { at: 1000, playing: false }, { at: 1500, force: { t: 5.0 } }, { at: 1502, restart: true }, { at: 1550, pos: 4.82 }], 2200);
  check("G8 暂停：无相符回报时显示目标", Math.abs(at(out, 2200) - 5.0) < 1e-9 && Math.abs(at(out, 1700) - 1.0) < 0.01, `@1700=${at(out, 1700).toFixed(3)} final=${at(out, 2200)}`);
}

// ── H. codex 第五轮：方向键连按(目标按累计计算 15→20→25，mpv 把排队的相对 seek 合并) ──
{
  const out = run([...steady(0, 1000), { at: 1000, force: { t: 15 } }, { at: 1030, force: { t: 20 } }, { at: 1060, force: { t: 25 } },
    { at: 1080, pos: 25 }, { at: 1081, ap: null }, { at: 1085, restart: true }, ...after(25, 1110, 2000)], 2000, { duration: 60 });
  const tt = tickAt(out, 1900);
  check("H1 方向键三连按：跟随合并后的落点 25", Math.abs(at(out, 1090) - 25) < 1e-9 && Math.abs(at(out, 1900) - (25 + (tt - 1110) / 1000)) < 0.003,
    `@1090=${at(out, 1090)} err=${((at(out, 1900) - (25 + (tt - 1110) / 1000)) * 1000).toFixed(1)}ms`);
}
{
  // 连按但 mpv 逐次执行(每次都有落点 + restart)：最终跟随最后一次
  const out = run([...steady(0, 1000), { at: 1000, force: { t: 15 } }, { at: 1005, pos: 15 }, { at: 1006, ap: null }, { at: 1008, restart: true },
    { at: 1030, force: { t: 20 } }, { at: 1035, pos: 20 }, { at: 1036, ap: null }, { at: 1038, restart: true }, ...after(20, 1060, 2000)], 2000, { duration: 60 });
  const tt = tickAt(out, 1900);
  check("H2 连按逐次执行：跟随最后一次落点", Math.abs(at(out, 1900) - (20 + (tt - 1060) / 1000)) < 0.003, `err=${((at(out, 1900) - (20 + (tt - 1060) / 1000)) * 1000).toFixed(1)}ms`);
}

// ── P. §6.33 暂停停帧：有视频时暂停对齐屏幕停住的帧(= 暂停时最新 time-pos)，恢复时等声音追上 ──
// steady()：音频真值 t/1000，time-pos 超前 40ms；2000ms 暂停时最后一条 time-pos 为 2.02(1980.1ms)
const V = { hasVideo: true };
{
  const out = run([...steady(0, 2000), { at: 2000, playing: false }, { at: 2600, pos: 1.9996 }, { at: 3000, pos: 2.02 }], 3200, V);
  const paused = out.filter(([t]) => t > 2001);
  check("P1 视频暂停：光标对齐暂停时最新 time-pos(屏幕停住的帧)，此后不再移动",
    paused.every(([, d]) => Math.abs(d - 2.02) < 1e-9), `@2001=${paused[0][1].toFixed(4)} final=${at(out, 3200).toFixed(4)}`);
}
{
  // 乱序：暂停前刚产生的 2.06 晚于 pause 到达(采用)，更早的 2.02 更晚到(不回退)。
  // 两条落在不同帧：同一帧内 store 只留最后到的一条，那是 store 的固有限制(需乱序超过一帧才会发生)
  const out = run([...steady(0, 2000), { at: 2000, playing: false }, { at: 2003, pos: 2.06 }, { at: 2015, pos: 2.02 }], 2600, V);
  check("P2 乱序：窗口内取最靠后的一条，不被更早的旧值拉回", Math.abs(at(out, 2600) - 2.06) < 1e-9, `final=${at(out, 2600).toFixed(4)}`);
}
{
  // 窗口外(150ms 后)才到的回报不跟随(§6.22)
  const out = run([...steady(0, 2000), { at: 2000, playing: false }, { at: 2200, pos: 2.09 }], 2600, V);
  check("P3 暂停 150ms 后才到的回报不跟随", Math.abs(at(out, 2600) - 2.02) < 1e-9, `final=${at(out, 2600).toFixed(4)}`);
}
{
  // time-pos 停更(1Hz poll 兜底时)：最后回报 1s 前 → 不吸附，保持暂停瞬间位置；
  // 暂停时 store 里是相差 >0.3s 的离谱值 → 不采用它，退回播放中缓存的相容回报 2.02
  const stale = run([...steady(0, 2000, false), { at: 1000.5, pos: 1.04 }, { at: 2000, playing: false }], 2400, V);
  const far = run([...steady(0, 2000), { at: 1999, pos: 2.5 }, { at: 2000, playing: false }], 2400, V);
  const ref = (o: typeof stale) => o.filter(([t]) => t < 2000).at(-1)![1];
  check("P4 陈旧回报不吸附；过远的回报不采用(退回缓存里相容的一条)",
    Math.abs(at(stale, 2400) - ref(stale)) < 0.008 && Math.abs(at(far, 2400) - 2.02) < 1e-9 && far.every(([, d]) => d < 2.4),
    `stale ${ref(stale).toFixed(4)}→${at(stale, 2400).toFixed(4)} far ${ref(far).toFixed(4)}→${at(far, 2400).toFixed(4)}`);
}
{
  const audioOnly = run([...steady(0, 2000), { at: 2000, playing: false }], 2400, { hasVideo: false });
  const unknown = run([...steady(0, 2000), { at: 2000, playing: false }], 2400, { hasVideo: null });
  check("P5 纯音频 / 音轨表未知：暂停不吸附(§6.22 原行为)",
    Math.abs(at(audioOnly, 2400) - 2.02) > 0.01 && Math.abs(at(unknown, 2400) - 2.02) > 0.01,
    `audio=${at(audioOnly, 2400).toFixed(4)} unknown=${at(unknown, 2400).toFixed(4)}`);
}
{
  // 恢复：声音从暂停位置(≈1.997)接着响，3030ms 起出声；光标停在 2.02 等它追上(≈3053ms)，之后跟随、不倒退
  const out = run([...steady(0, 2000), { at: 2000, playing: false }, { at: 3000, playing: true }, ...after(1.997, 3030, 4000)], 4000, V);
  const tt = tickAt(out, 3600);
  const truth = 1.997 + (tt - 3030) / 1000;
  check("P6 恢复：原地等声音追上暂停帧再走，不倒退，随后与声音一致",
    Math.abs(at(out, 3045) - 2.02) < 1e-9 && at(out, 3070) > 2.02 && !backMovesWhile(out, 1990, 4000) && Math.abs(at(out, 3600) - truth) < 0.001,
    `@3045=${at(out, 3045).toFixed(4)} @3070=${at(out, 3070).toFixed(4)} err@3600=${((at(out, 3600) - truth) * 1000).toFixed(2)}ms`);
}
{
  // 恢复后声音迟迟不来：超时(超前量 + 150ms)后照常走，不永久钉住
  const out = run([...steady(0, 2000), { at: 2000, playing: false }, { at: 3000, playing: true }], 3400, V);
  check("P7 恢复后声音不来：超时后照常前进", Math.abs(at(out, 3100) - 2.02) < 1e-9 && at(out, 3300) > 2.1 && !backMovesWhile(out, 1990, 3400),
    `@3100=${at(out, 3100).toFixed(4)} @3300=${at(out, 3300).toFixed(4)}`);
}
{
  // 暂停吸附后又在暂停中 seek：op 接管；恢复时不再按旧超前量等待
  const out = run([...steady(0, 2000), { at: 2000, playing: false }, { at: 2500, force: { t: 5 } }, { at: 2505, pos: 5 }, { at: 2506, restart: true },
    { at: 3000, playing: true }, ...after(5, 3020, 3600)], 3600, V);
  const tt = tickAt(out, 3500);
  check("P8 暂停吸附后 seek：落点 5，恢复后跟随新位置", Math.abs(at(out, 2900) - 5) < 1e-9 && Math.abs(at(out, 3500) - (5 + (tt - 3020) / 1000)) < 0.003,
    `@2900=${at(out, 2900)} err@3500=${((at(out, 3500) - (5 + (tt - 3020) / 1000)) * 1000).toFixed(1)}ms`);
}
{
  // seek 后还在 hold(音频未恢复)时暂停：op 负责，不启用暂停停帧
  const out = run([...steady(0, 1000), { at: 1000, force: { t: 8 } }, { at: 1005, pos: 8.0 }, { at: 1006, ap: null }, { at: 1008, restart: true },
    { at: 1020, playing: false }, { at: 1040, pos: 8.0417 }], 1600, V);
  check("P9 op 进行中暂停：按 op 规则(相符回报)处理", Math.abs(at(out, 1600) - 8.0417) < 1e-9, `final=${at(out, 1600)}`);
}
{
  // 无音轨视频：光标按 time-pos 外推(会越过最后一帧)，暂停时按设计回退到最后一帧(≤1 帧)；
  // 恢复后不等待、不倒退
  const s: Step[] = [];
  for (let t = 0; t < 2000; t += 42) s.push({ at: t, pos: t / 1000 });
  const out = run([...s, { at: 2000, playing: false }, { at: 3000, playing: true }, { at: 3042, pos: 2.016 }, { at: 3084, pos: 2.058 }], 3300, { hasVideo: true, hasAudio: false });
  const before = out.filter(([t]) => t < 2000).at(-1)![1];
  const back = before - at(out, 2500);
  check("P10 无音轨视频：暂停回退到最后一帧(≤1 帧)，恢复后按 time-pos 前进、不倒退",
    Math.abs(at(out, 2500) - 1.974) < 1e-9 && back >= 0 && back <= 0.042 + 1e-9 && at(out, 3030) > 1.974 && !backMovesWhile(out, 2001, 3300),
    `暂停前=${before.toFixed(4)} 回退=${(back * 1000).toFixed(1)}ms @3030=${at(out, 3030).toFixed(4)}`);
}
{
  // 单曲循环：视频已回绕(time-pos 0.01)而声音还在上一圈末尾时暂停 → 按环形距离对齐到 0.01
  const s: Step[] = [];
  for (let t = 1000; t < 1980; t += 60) { s.push({ at: t, ap: t / 1000 }); s.push({ at: t + 0.1, pos: Math.min(t / 1000 + 0.04, 1.999) }); }
  const out = run([...s, { at: 1981, pos: 0.01 }, { at: 1990, playing: false }], 2300, { hasVideo: true, loopFile: true, duration: 2 });
  check("P11 单曲循环回绕处暂停：对齐到已回绕的画面帧", Math.abs(at(out, 2300) - 0.01) < 1e-9, `final=${at(out, 2300).toFixed(4)}`);
}
{
  // codex 反例：暂停时 store 里是一条乱序晚到的旧 time-pos(0.83，比声音落后 0.22s) → 不采用
  const out = run([{ at: 1000, pos: 1.04, ap: 1.0 }, { at: 1050, pos: 1.09, ap: 1.05 }, { at: 1102, pos: 0.83 }, { at: 1110, playing: false }], 1300, V);
  check("P12 迟到的旧 time-pos 不把暂停光标拉回", at(out, 1300) >= 1.05 - 1e-9, `final=${at(out, 1300).toFixed(4)}`);
}
{
  // codex 反例：窗口在后台(rAF 停)期间播放并暂停；回到前台时取停滞期间最新的 time-pos
  const out = run([{ at: 1000, pos: 1.04, ap: 1.0 }, { at: 4995, pos: 5.04, ap: 5.0 }, { at: 4999, playing: false }], 5300, V, [[1001, 5000]]);
  check("P13 后台期间由播放转为暂停：光标取最新 time-pos，不停在数秒前", Math.abs(at(out, 5300) - 5.04) < 1e-9, `final=${at(out, 5300).toFixed(4)}`);
}
{
  // EOF 自动暂停(probes 实测序列，24fps 12s)：末帧 11.95833 → eof → pause 同时报 11.95905 → 126ms 后
  // 报音频尾巴 12.0045(超出 duration)。光标停在末帧，不跟尾巴；pause 先于 eof 到达的乱序同样如此
  const tail: Step[] = [];
  for (let t = 11000; t < 11960; t += 42) { tail.push({ at: t, ap: t / 1000 - 0.04 }); tail.push({ at: t + 0.1, pos: Math.floor((t / 1000) * 24) / 24 }); }
  const base = { hasVideo: true, duration: 12 };
  const inOrder = run([...tail, { at: 11958, pos: 11.95833 }, { at: 11958.5, eof: true }, { at: 12000, playing: false, pos: 11.95905 }, { at: 12126, pos: 12.0045 }], 12400, base);
  const reordered = run([...tail, { at: 11958, pos: 11.95833 }, { at: 12000, playing: false, pos: 11.95905 }, { at: 12010, eof: true }, { at: 12126, pos: 12.0045 }], 12400, base);
  check("P14 EOF 自动暂停：停在末帧，不跟随随后报来的音频尾巴",
    Math.abs(at(inOrder, 12400) - 11.95905) < 1e-9 && Math.abs(at(reordered, 12400) - 11.95905) < 1e-9,
    `顺序=${at(inOrder, 12400).toFixed(5)} 乱序=${at(reordered, 12400).toFixed(5)}`);
}
{
  // codex 第二轮反例(60fps)：正确帧 1.05 之后，一条落后界以内的旧值 0.966667 最后覆盖 store 再暂停。
  // 播放中缓存的回报里仍有 1.05 → 取它；无音轨(光标按 time-pos 外推)同样如此
  const seq: Step[] = [{ at: 900, ap: 0.9, pos: 0.95 }, { at: 950, ap: 0.95, pos: 1.0 }, { at: 1000, ap: 1.0, pos: 1.05 }, { at: 1009, pos: 0.966667 }, { at: 1010, playing: false }];
  const withAudio = run(seq, 1300, V);
  const noAudio = run(seq.map((s) => ({ ...s, ap: undefined })), 1300, { hasVideo: true, hasAudio: false });
  check("P15 落后界内的旧值最后到达：仍取缓存里最靠后的帧",
    Math.abs(at(withAudio, 1300) - 1.05) < 1e-9 && Math.abs(at(noAudio, 1300) - 1.05) < 1e-9,
    `有音轨=${at(withAudio, 1300).toFixed(4)} 无音轨=${at(noAudio, 1300).toFixed(4)}`);
}
{
  // codex 第二轮反例(单曲循环)：声音 0.02、正确帧 0.06，上一圈的旧值 1.99 最后到达 → 仍停在 0.06
  const s: Step[] = [];
  for (let t = 1000; t < 1990; t += 60) { s.push({ at: t, ap: t / 1000 }); s.push({ at: t + 0.1, pos: Math.min(t / 1000 + 0.04, 1.999) }); }
  const out = run([...s, { at: 1990, ap: 1.99, pos: 0.03 }, { at: 2020, ap: 0.02, pos: 0.06 }, { at: 2025, pos: 1.99 }, { at: 2026, playing: false }], 2300, { hasVideo: true, loopFile: true, duration: 2 });
  check("P16 单曲循环：上一圈的旧值最后到达，不被拉回", Math.abs(at(out, 2300) - 0.06) < 1e-9, `final=${at(out, 2300).toFixed(4)}`);
}
{
  // codex 第二轮反例(EOF)：pause 先到(eof 仍为 false)，126ms 后音频尾巴 12.0045 先于 eof-reached 到达
  // → eof 一到退回暂停那一刻的末帧
  const tail: Step[] = [];
  for (let t = 11000; t < 11960; t += 42) { tail.push({ at: t, ap: t / 1000 - 0.04 }); tail.push({ at: t + 0.1, pos: Math.floor((t / 1000) * 24) / 24 }); }
  const out = run([...tail, { at: 11958, pos: 11.95833 }, { at: 12000, playing: false, pos: 11.95905 }, { at: 12126, pos: 12.0045 }, { at: 12135, eof: true }], 12400, { hasVideo: true, duration: 12 });
  check("P17 EOF：音频尾巴先于 eof-reached 到达，eof 一到退回末帧", Math.abs(at(out, 12400) - 11.95905) < 1e-9, `@12130=${at(out, 12130).toFixed(5)} final=${at(out, 12400).toFixed(5)}`);
}
{
  // codex 第三轮反例：小幅向后 seek(1.00→0.90)刚解除钉住，seek 前产生的旧值 1.05 迟到，随后正确的 0.95，
  // 再暂停。op 结束后的静默期内不收缓存 → 按 store 当前值 0.95，旧高值不被选中
  const out = run([{ at: 900, ap: 0.96, pos: 1.0 }, { at: 1000, force: { t: 0.9 } }, { at: 1005, pos: 0.9 }, { at: 1006, restart: true },
    { at: 1040, ap: 0.9 }, { at: 1060, pos: 1.05 }, { at: 1065, pos: 0.95 }, { at: 1070, playing: false }], 1300, V);
  check("P18 seek 刚结束时迟到的旧高值不被选中", Math.abs(at(out, 1300) - 0.95) < 1e-9 && out.filter(([t]) => t > 1070).every(([, d]) => d < 1.0),
    `final=${at(out, 1300).toFixed(4)}`);
}
{
  // codex 第三轮反例：变速同一帧到达的旧时钟高值 1.20 不进缓存；变速后正确值 1.07 到达后暂停 → 1.07
  const out = run([{ at: 900, ap: 0.9, pos: 0.95 }, { at: 1000, ap: 1.0, pos: 1.05 }, { at: 1010, speed: 2, pos: 1.2 }, { at: 1020, pos: 1.07 }, { at: 1030, playing: false }], 1300, V);
  check("P19 变速同帧到达的旧高值不被选中", Math.abs(at(out, 1300) - 1.07) < 1e-9, `final=${at(out, 1300).toFixed(4)}`);
}
{
  // codex 第三轮反例：EOF 时暂停那一刻没有合格候选(time-pos 停在 1s 前)。随后的尾巴：超出时长的 12.0045 不采用；
  // 未超出时长的 11.99(vo=null 实测形态)先被采用，eof 一到撤回到暂停瞬间的光标
  const base: Step[] = [{ at: 11000, pos: 11.0 }];
  for (let t = 11000; t < 12000; t += 42) base.push({ at: t + 0.2, ap: t / 1000 - 0.06 });
  const over = run([...base, { at: 12000, playing: false }, { at: 12120, pos: 12.0045 }, { at: 12130, eof: true }], 12400, { hasVideo: true, duration: 12 });
  const under = run([...base, { at: 12000, playing: false }, { at: 12100, pos: 11.99 }, { at: 12130, eof: true }], 12400, { hasVideo: true, duration: 12 });
  const ref = over.filter(([t]) => t < 12000).at(-1)![1];
  check("P20 EOF 且暂停时无候选：超出时长的尾巴不采用，未超出的在 eof 到达后撤回",
    Math.abs(at(over, 12400) - ref) < 0.008 && Math.abs(at(under, 12400) - at(under, 12050)) < 1e-9 && Math.abs(at(under, 12120) - 11.99) < 1e-9,
    `暂停瞬间≈${ref.toFixed(4)} over=${at(over, 12400).toFixed(4)} under: @12120=${at(under, 12120).toFixed(4)} final=${at(under, 12400).toFixed(4)}`);
}

// ── S. §6.35 起播 / 卡顿停滞：两路回报都停更 → 外推封顶、不越过；恢复后光标超前则原地等声音 ──
{
  // App 首次打开视频的实测形态(ppause24)：加载 op → restart 时 audio-pts 0.0004 → 约 400ms 无任何回报
  // (声音也没走) → 恢复后从 0.0334 起正常。改前：外推到 0.39 再硬 snap 回 0.03
  const s: Step[] = [{ at: 0, force: { t: 0 } }, { at: 4, restart: true }, { at: 5, pos: 0.0417, ap: 0.0004 }];
  for (let t = 405; t < 1500; t += 42) s.push({ at: t, ap: 0.0334 + (t - 405) / 1000, pos: 0.0833 + (t - 405) / 1000 });
  const out = run(s, 1500, { hasVideo: true });
  const peak = Math.max(...out.filter(([t]) => t < 405).map(([, d]) => d));
  const tt = tickAt(out, 1400);
  // 落点回报 time-pos 0.0417、首条 audio-pts 0.0004：解除时不后退保护让光标留在 0.0417，封顶以此为基准
  check("S1 起播停顿：外推封顶(落点 + ≤0.15s)、不倒退，恢复后与声音一致",
    peak <= 0.0417 + 0.15 + 1e-6 && !backMovesWhile(out, 0, 1500) && Math.abs(at(out, 1400) - (0.0334 + (tt - 405) / 1000)) < 0.002,
    `停顿中最远=${peak.toFixed(4)} err@1400=${((at(out, 1400) - (0.0334 + (tt - 405) / 1000)) * 1000).toFixed(1)}ms`);
}
{
  // 播放中两路都停 300ms(解码 / 输出卡顿，声音也停)：光标至多多走 0.15s 后停住，恢复后等声音，不倒退
  const s: Step[] = steady(0, 2000);
  for (let t = 2300; t < 3500; t += 60) { s.push({ at: t, ap: (t - 300) / 1000 }); s.push({ at: t + 0.1, pos: (t - 300) / 1000 + 0.04 }); }
  const out = run(s, 3500);
  const peak = Math.max(...out.filter(([t]) => t < 2300).map(([, d]) => d));
  const tt = tickAt(out, 3300);
  check("S2 播放中卡顿：不越过封顶、不倒退，恢复后与声音一致",
    peak <= 1.98 + 0.15 + 1e-6 && !backMovesWhile(out, 0, 3500) && Math.abs(at(out, 3300) - (tt - 300) / 1000) < 0.002,
    `卡顿中最远=${peak.toFixed(4)} err@3300=${((at(out, 3300) - (tt - 300) / 1000) * 1000).toFixed(1)}ms`);
}
{
  // 音频先于视频结束：audio-pts 停更但 time-pos 照常 → 不是停滞，光标照常前进(不在 0.15s 处停住)
  const s: Step[] = steady(0, 2000);
  for (let t = 2000; t < 3000; t += 42) s.push({ at: t, pos: t / 1000 + 0.04 });
  const out = run(s, 3000, { hasVideo: true });
  check("S3 音频先结束、画面继续：不判为停滞", out.filter(([t]) => t > 2000 && t < 3000).every(([, , src]) => src !== "stall") && at(out, 2500) > 2.4,
    `@2500=${at(out, 2500).toFixed(4)}`);
}
{
  // 纯音频回报间隔 110ms(实测最大约 100ms)：不触发停滞
  const s: Step[] = [];
  for (let t = 0; t < 3000; t += 110) { s.push({ at: t, ap: t / 1000 }); s.push({ at: t + 0.1, pos: t / 1000 }); }
  const out = run(s, 3000, { hasVideo: false });
  check("S4 纯音频 110ms 间隔：不触发停滞", out.every(([, , src]) => src !== "stall"), "");
}
{
  // 事件只是慢了(170ms 一条)而时钟在走：短暂封顶后新回报在前 → 向前跟上，不倒退
  const s: Step[] = steady(0, 1000);
  s.push({ at: 1150, ap: 1.15 }, { at: 1150.1, pos: 1.19 });
  for (let t = 1320; t < 2000; t += 60) { s.push({ at: t, ap: t / 1000 }); s.push({ at: t + 0.1, pos: t / 1000 + 0.04 }); }
  const out = run(s, 2000);
  const tt = tickAt(out, 1800);
  check("S5 回报变慢但时钟在走：不倒退，随后与声音一致", !backMovesWhile(out, 0, 2000) && Math.abs(at(out, 1800) - tt / 1000) < 0.003,
    `err@1800=${((at(out, 1800) - tt / 1000) * 1000).toFixed(1)}ms`);
}
{
  // codex 反例(§6.33 原列为限制)：暂停帧 2.04；暂停中 store 收到远落后的旧 audio-pts 1.3；恢复后迟迟没有新回报。
  // 等声超时后两路都停更 → 按停滞处理，光标停在暂停帧，不被旧值拉回
  const out = run([{ at: 1000, pos: 2.04, ap: 2.0 }, { at: 1010, playing: false }, { at: 1100, ap: 1.3 }, { at: 2000, playing: true }], 2500, V);
  check("S6 恢复后无新回报、store 里是远落后的旧 audio-pts：不倒退", !backMovesWhile(out, 0, 2500) && at(out, 2400) >= 2.04 - 1e-9,
    `@2400=${at(out, 2400).toFixed(4)}`);
}
{
  // codex 反例(§6.33 原列为限制)：暂停中改 2 倍速，恢复后 210ms 才有新音频 2.00 → 原地等它追上，不回退
  const out = run([{ at: 1000, pos: 2.04, ap: 2.0 }, { at: 1010, playing: false }, { at: 1500, speed: 2 }, { at: 2000, playing: true },
    { at: 2210, ap: 2.0 }, { at: 2400, ap: 2.38 }, { at: 2600, ap: 2.78 }], 2800, V);
  check("S7 暂停中变速 + 恢复后音频迟到：不回退，随后与声音一致", !backMovesWhile(out, 0, 2800) && Math.abs(at(out, 2700) - (2.78 + (tickAt(out, 2700) - 2600) / 500)) < 0.01,
    `@2210=${at(out, 2210).toFixed(3)} @2700=${at(out, 2700).toFixed(3)}`);
}
{
  // codex 反例：起播停顿期间暂停 / 恢复两次(两路一直没有新回报)，950ms 声音才开始。
  // 暂停时对齐屏幕帧(停滞中的最后一条 time-pos 0.0417，按设计回退)；播放期间不重新外推过头、不倒退；声音开始后跟上
  const s: Step[] = [{ at: 0, force: { t: 0 } }, { at: 4, restart: true }, { at: 5, pos: 0.0417, ap: 0.0004 },
    { at: 300, playing: false }, { at: 400, playing: true }, { at: 650, playing: false }, { at: 750, playing: true }];
  for (let t = 950; t < 1800; t += 42) s.push({ at: t, ap: 0.01 + (t - 950) / 1000, pos: 0.05 + (t - 950) / 1000 });
  const out = run(s, 1800, { hasVideo: true });
  const peak = Math.max(...out.filter(([t]) => t < 950).map(([, d]) => d));
  const tt = tickAt(out, 1700);
  const playBack = backMovesWhile(out, 0, 299) || backMovesWhile(out, 401, 649) || backMovesWhile(out, 751, 1800);
  check("S8 停顿中暂停 / 恢复：暂停对齐屏幕帧，播放中不倒退、不外推过头，声音开始后跟上",
    Math.abs(at(out, 390) - 0.0417) < 1e-9 && Math.abs(at(out, 740) - 0.0417) < 1e-9 && peak <= 0.0417 + 0.15 + 1e-6 && !playBack &&
      Math.abs(at(out, 1700) - (0.01 + (tt - 950) / 1000)) < 0.003,
    `暂停时=${at(out, 390).toFixed(4)}/${at(out, 740).toFixed(4)} 停顿中最远=${peak.toFixed(4)} err@1700=${((at(out, 1700) - (0.01 + (tt - 950) / 1000)) * 1000).toFixed(1)}ms`);
}
{
  // 真卡住 1.2s(>600ms)，期间 1Hz poll 拿回同一个 time-pos：一直停住(600ms 处不跳去 time-pos 外推)，恢复后不倒退
  // (App 的 1Hz poll 只在与当前值相差 >0.1s 时写入 store，卡住时不会写；这里没有 poll 回报)
  const s: Step[] = steady(0, 2000);
  for (let t = 3200; t < 4200; t += 60) { s.push({ at: t, ap: (t - 1200) / 1000 }); s.push({ at: t + 0.1, pos: (t - 1200) / 1000 + 0.04 }); }
  const out = run(s, 4200);
  const during = out.filter(([t]) => t > 2200 && t < 3200).map(([, d]) => d);
  const tt = tickAt(out, 4100);
  check("S9 卡住 1.2s(>600ms)：一直停住、600ms 处不跳、不倒退，恢复后跟上",
    Math.max(...during) - Math.min(...during) < 1e-9 && !backMovesWhile(out, 0, 4200) && Math.abs(at(out, 4100) - (tt - 1200) / 1000) < 0.003,
    `停住于 ${during[0].toFixed(4)} err@4100=${((at(out, 4100) - (tt - 1200) / 1000) * 1000).toFixed(1)}ms`);
}
{
  // E5 补充：事件断了但时钟在走(poll 值在前进) → 第一次 poll 之后不再判停滞，按 time-pos 平滑外推
  const steps: Step[] = [...steady(0, 2000, true, 0)];
  for (let t = 3000; t <= 5000; t += 1000) steps.push({ at: t, pos: t / 1000 });
  const out = run(steps, 5000);
  check("S10 事件断了、poll 值在前进：首次 poll 后不再停滞", out.filter(([t]) => t > 3010).every(([, , src]) => src !== "stall"), "");
}
{
  // codex 反例：事件断了、3s 的 poll 证明时钟在走(豁免)，之后视频也卡住(再无前进)：豁免 1.5s 后失效，重新判停滞
  const steps: Step[] = [...steady(0, 2000, true, 0), { at: 3000, pos: 3.0 }];
  const out = run(steps, 5000);
  check("S11 豁免有时限：poll 前进后又卡住，1.5s 后重新判停滞", out.filter(([t]) => t > 4600).every(([, , src]) => src === "stall"),
    `@4700 src=${out.filter(([t]) => t <= 4700).at(-1)![2]}`);
}
{
  // codex 反例：单曲循环 6s，从 5.75 seek 到 5.90；解除钉住后一条 seek 前的旧帧 5.75 迟到，紧接着暂停。
  // op 结束后的静默期内不放宽循环末尾的落后界 → 不采用 5.75
  const s: Step[] = [];
  for (let t = 1000; t < 1750; t += 42) { s.push({ at: t, ap: 5.0 + (t - 1000) / 1000 }); s.push({ at: t + 0.1, pos: 5.04 + (t - 1000) / 1000 }); }
  s.push({ at: 1750, force: { t: 5.9 } }, { at: 1755, pos: 5.9 }, { at: 1756, restart: true }, { at: 1790, ap: 5.88 }, { at: 1800, pos: 5.75 }, { at: 1805, playing: false });
  const out = run(s, 2100, { hasVideo: true, loopFile: true, duration: 6 });
  check("S12 循环末尾 seek 后迟到的旧帧不被采用", at(out, 2100) >= 5.88 - 1e-9, `final=${at(out, 2100).toFixed(4)}`);
}
{
  // codex 反例：刚回绕到开头(光标已取模，audio-pts 还是上一圈的负值尾巴 −0.0083)，屏幕帧 time-pos 0.0417；
  // 148ms 无回报后暂停(光标已超出屏幕帧 >50ms、尚未判停滞) → 仍对齐到 0.0417(循环边界放宽落后界)
  const s: Step[] = [];
  for (let t = 1000; t < 1900; t += 42) { s.push({ at: t, ap: 5.0 + (t - 1000) / 1000 }); s.push({ at: t + 0.1, pos: 5.04 + (t - 1000) / 1000 }); }
  s.push({ at: 1950, pos: 0.0417, ap: -0.0083 }, { at: 2098, playing: false });
  const out = run(s, 2300, { hasVideo: true, loopFile: true, duration: 6 });
  check("S13 刚回绕到开头时暂停：对齐屏幕帧", Math.abs(at(out, 2300) - 0.0417) < 1e-9, `暂停前=${at(out, 2095).toFixed(4)} final=${at(out, 2300).toFixed(4)}`);
}
{
  // codex 反例：停滞中 seek 回同一位置，restart 后回报的数值与之前完全相同 → op 后首条回报算"前进"，不误判停滞
  const s: Step[] = [...steady(0, 2000), { at: 3000, force: { t: 2.02 } }, { at: 3005, pos: 2.02 }, { at: 3006, restart: true }, { at: 3010, ap: 1.98 }];
  for (let t = 3060; t < 4300; t += 50) { s.push({ at: t, ap: 1.98 + (t - 3010) / 1000 }); s.push({ at: t + 0.1, pos: 2.02 + (t - 3010) / 1000 }); }
  const out = run(s, 4300);
  const tt = tickAt(out, 4200);
  // 落点 2.02 比音频超前 40ms：解除时"不后退"保护按 −10% 慢追(原有 seek 行为)，所以在 1.2s 后检查
  check("S14 seek 回同一位置、数值相同：不误判停滞，随后跟上", out.filter(([t]) => t > 3006 && t < 3150).every(([, , src]) => src !== "stall") &&
    Math.abs(at(out, 3020) - 2.02) < 0.01 && Math.abs(at(out, 4200) - (1.98 + (tt - 3010) / 1000)) < 0.003,
    `@3020=${at(out, 3020).toFixed(4)} err@4200=${((at(out, 4200) - (1.98 + (tt - 3010) / 1000)) * 1000).toFixed(1)}ms`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures ? 1 : 0;
