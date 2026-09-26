// 用户操作序列的真实 mpv 录制回放（libmpv ctypes，ao=null）：暂停中单帧前进 / 后退、
// 播放中单帧前进、暂停中 seek（视频 / wav）、暂停后 seek、切文件。
// 断言每个动作 380ms 后光标的位置（与 App 相同：seek 带目标提示，帧步进不等 restart）。
// 用法：node --experimental-strip-types --no-warnings dev-tools/sync/clock/steps.test.ts [模拟事件链延迟ms]
import { readFileSync } from "node:fs";
import { createPlayheadClock, type ClockInput } from "../../../src/lib/playheadClock.ts";

const DATA = new URL("./data/steps/", import.meta.url);
const LAT = Number(process.argv[2] ?? "0");

type Expect = "time-pos" | number | { near: "time-pos"; tol: number };
// 每个用户动作(按顺序)之后 +380ms 的期望
const cases: Record<string, Expect[]> = {
  "pfstep5.json": ["time-pos", "time-pos", "time-pos", "time-pos", "time-pos"], // 暂停中连按 5 次单帧前进
  "pfback5.json": ["time-pos", "time-pos", "time-pos", "time-pos"], // 暂停中连按 4 次单帧后退
  "fstep.json": ["time-pos"], // 播放中单帧前进(mpv 随后暂停)
  "pseek2.json": [0.8333], // 暂停中 seek 视频：落到真实显示帧
  "pseekwav.json": [0.81], // 暂停中 seek wav：不采用 AO 缓冲虚值 0.6262
  "seekpause.json": [0.8333],
  "loadnext.json": [{ near: "time-pos", tol: 0.06 }], // 切文件后跟上新文件的时钟
};

let failures = 0;
for (const [file, expects] of Object.entries(cases)) {
  const evs: any[] = JSON.parse(readFileSync(new URL(file, DATA), "utf8"));
  const clk = createPlayheadClock();
  const st: ClockInput = { playing: false, position: 0, positionObservedAt: 0, audioPts: null, audioPtsObservedAt: 0, restartAt: 0, hasAudio: true, speed: 1, duration: 12, dragPosition: null, loopFile: false };
  let isPlaying = true, fileLoaded = false, i = 0;
  const sorted = evs.map((e) => ({ ...e, at: (e.t + (e.act ? 0 : LAT / 1000)) * 1000 })).sort((a, b) => a.at - b.at);
  const acts = sorted.filter((e) => e.act && !/pause/.test(e.act));
  let ni = 0;
  // 播放中的非用户倒退(用户 seek / 切文件引起的除外)
  let unexpectedBack = 0, prev: number | null = null, prevPlaying = false, lastActAt = -Infinity;
  for (let t = 1; t < sorted.at(-1).at + 1300; t += 1000 / 144) {
    while (i < sorted.length && sorted[i].at <= t) {
      const e = sorted[i++];
      if (e.act) {
        if (/^seek/.test(e.act)) { clk.forceSnap(e.at, true, Number(e.act.split(",")[1])); lastActAt = e.at; }
        else if (/^loadfile/.test(e.act)) { clk.forceSnap(e.at, true, 0); lastActAt = e.at; }
        else if (/^frame-(back-)?step/.test(e.act)) { clk.forceSnap(e.at, false); lastActAt = e.at; }
      } else if (e.ev === "file-loaded") fileLoaded = true;
      else if (e.ev === "start-file") fileLoaded = false;
      else if (e.ev === "playback-restart") st.restartAt = e.at;
      else if (e.name === "time-pos") { st.position = e.v ?? 0; st.positionObservedAt = e.at; }
      else if (e.name === "audio-pts") { st.audioPts = e.v ?? null; st.audioPtsObservedAt = e.at; }
      else if (e.name === "pause") isPlaying = !e.v;
    }
    st.playing = isPlaying && fileLoaded;
    const d = clk.tick({ ...st }, t);
    if (prev !== null && st.playing && prevPlaying && d < prev - 1e-9 && t - lastActAt > 150) unexpectedBack++;
    prev = d; prevPlaying = st.playing;
    while (ni < acts.length && t >= acts[ni].at + 380) {
      const exp = expects[ni];
      const want = exp === "time-pos" ? st.position : typeof exp === "number" ? exp : st.position;
      const tol = typeof exp === "object" ? exp.tol : 1e-4;
      const ok = Math.abs(d - want) <= tol;
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${file.padEnd(15)} #${ni + 1} ${acts[ni].act.slice(0, 22).padEnd(22)} 光标=${d.toFixed(4)} 期望=${want.toFixed(4)} (time-pos=${st.position.toFixed(4)})`);
      ni++;
    }
  }
  const ok = unexpectedBack === 0;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${file.padEnd(15)} 播放中非操作引起的倒退帧数=${unexpectedBack}`);
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures ? 1 : 0;
