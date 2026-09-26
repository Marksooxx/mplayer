// §6.22 历史雷区 + op 状态机边界 + 评审反例（codex / workflow）的合成事件测试
import { createPlayheadClock, type ClockInput } from "../../../src/lib/playheadClock.ts";

type Step = {
  at: number; pos?: number; ap?: number | null; playing?: boolean; force?: boolean | "step" | { t: number };
  hasAudio?: boolean | null; speed?: number; restart?: boolean; drag?: number | null;
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures ? 1 : 0;
