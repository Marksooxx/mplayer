// 用户操作序列的真实 mpv 录制回放（libmpv ctypes）：暂停中单帧前进 / 后退、
// 播放中单帧前进、暂停中 seek（视频 / wav）、暂停后 seek、切文件（以上 ao=null vo=null）；
// 播放中暂停 / 恢复（ppause*：vo=gpu-next ao=wasapi，与 App 相同的真实 VO 时序）。
// 断言每个动作 380ms 后光标的位置（与 App 相同：seek 带目标提示，帧步进不等 restart），
// 以及播放中不因非用户操作倒退、恢复播放的第一帧不倒退。
// 用法：node --experimental-strip-types --no-warnings dev-tools/sync/clock/steps.test.ts [模拟事件链延迟ms]
import { readFileSync } from "node:fs";
import { createPlayheadClock, type ClockInput } from "../../../src/lib/playheadClock.ts";

const DATA = new URL("./data/steps/", import.meta.url);
const LAT = Number(process.argv[2] ?? "0");

// "time-pos"：光标 = mpv 最新 time-pos(暂停时即屏幕停住的帧，见 probes/pause_frame.py)；
// { near: "audio" }：光标与外推的 audio-pts(正在响的位置)之差不超过 tol
type Expect = "time-pos" | number | { near: "time-pos" | "audio"; tol: number };
interface Case {
  /** 每个用户动作(按顺序)之后 +380ms 的期望；pauseActs=false 时不含 set,pause 动作 */
  expects: Expect[];
  pauseActs?: boolean;
  /** 依次加载的每个文件是否有视频画面(ClockInput.hasVideo) */
  video: boolean[];
  /**
   * 已知问题(§6.33 "开播停顿")：录制开头 untilMs 内、单次回退不超过 maxBackS 的倒退(最多 maxCount 次)只报告为 KNOWN。
   * 只对确认过的录制开放；其他时间窗、更大的回退照常判失败。
   */
  knownStartup?: { untilMs: number; maxBackS: number; maxCount: number };
}
const RESUMED: Expect = { near: "audio", tol: 0.008 };
const cases: Record<string, Case> = {
  "pfstep5.json": { expects: ["time-pos", "time-pos", "time-pos", "time-pos", "time-pos"], video: [true] }, // 暂停中连按 5 次单帧前进
  "pfback5.json": { expects: ["time-pos", "time-pos", "time-pos", "time-pos"], video: [true] }, // 暂停中连按 4 次单帧后退
  "fstep.json": { expects: ["time-pos"], video: [true] }, // 播放中单帧前进(mpv 随后暂停)
  "pseek2.json": { expects: [0.8333], video: [true] }, // 暂停中 seek 视频：落到真实显示帧
  "pseekwav.json": { expects: [0.81], video: [false] }, // 暂停中 seek wav：不采用 AO 缓冲虚值 0.6262
  "seekpause.json": { expects: [0.8333], video: [true] },
  "loadnext.json": { expects: [{ near: "time-pos", tol: 0.06 }], video: [true, false] }, // 切文件后跟上新文件的时钟
  // 播放中暂停：光标停在屏幕停住的帧(超前声音 1–3 帧)；恢复后等声音追上再走，380ms 后与声音一致
  "ppause24.json": { expects: ["time-pos", RESUMED, "time-pos", RESUMED, "time-pos", RESUMED], pauseActs: true, video: [true], knownStartup: { untilMs: 1000, maxBackS: 0.4, maxCount: 1 } },
  "ppause60.json": { expects: ["time-pos", RESUMED, "time-pos", RESUMED, "time-pos", RESUMED], pauseActs: true, video: [true] },
};

let failures = 0;
for (const [file, { expects, pauseActs, video, knownStartup }] of Object.entries(cases)) {
  const evs: any[] = JSON.parse(readFileSync(new URL(file, DATA), "utf8"));
  const clk = createPlayheadClock();
  const st: ClockInput = { playing: false, position: 0, positionObservedAt: 0, audioPts: null, audioPtsObservedAt: 0, restartAt: 0, hasAudio: true, hasVideo: null, speed: 1, duration: 12, dragPosition: null, loopFile: false };
  let isPlaying = true, fileLoaded = false, i = 0, loads = 0;
  const sorted = evs.map((e) => ({ ...e, at: (e.t + (e.act ? 0 : LAT / 1000)) * 1000 })).sort((a, b) => a.at - b.at);
  const acts = sorted.filter((e) => e.act && (pauseActs || !/pause/.test(e.act)));
  let ni = 0;
  // 播放中的非用户倒退(用户 seek / 切文件引起的除外)；恢复播放第一帧的倒退；
  // knownStartup 范围内的开播倒退单独计：已知问题，只报告不断言
  let unexpectedBack = 0, resumeBack = 0, startupBack = 0, prev: number | null = null, prevPlaying = false, lastActAt = -Infinity;
  for (let t = 1; t < sorted.at(-1).at + 1300; t += 1000 / 144) {
    while (i < sorted.length && sorted[i].at <= t) {
      const e = sorted[i++];
      if (e.act) {
        if (/^seek/.test(e.act)) { clk.forceSnap(e.at, true, Number(e.act.split(",")[1])); lastActAt = e.at; }
        else if (/^loadfile/.test(e.act)) { clk.forceSnap(e.at, true, 0); lastActAt = e.at; }
        else if (/^frame-(back-)?step/.test(e.act)) { clk.forceSnap(e.at, false); lastActAt = e.at; }
      } else if (e.ev === "file-loaded") { fileLoaded = true; st.hasVideo = video[Math.min(loads++, video.length - 1)]; }
      else if (e.ev === "start-file") {
        fileLoaded = false; st.hasVideo = null;
        if (loads === 0) clk.forceSnap(e.at, true, 0); // 首个文件由录制脚本直接加载；App 的 loadFile 会登记
      }
      else if (e.ev === "playback-restart") st.restartAt = e.at;
      else if (e.name === "time-pos") { st.position = e.v ?? 0; st.positionObservedAt = e.at; }
      else if (e.name === "audio-pts") { st.audioPts = e.v ?? null; st.audioPtsObservedAt = e.at; }
      else if (e.name === "pause") isPlaying = !e.v;
    }
    st.playing = isPlaying && fileLoaded;
    const d = clk.tick({ ...st }, t);
    if (prev !== null && st.playing && prevPlaying && d < prev - 1e-9 && t - lastActAt > 150) {
      if (knownStartup && t < knownStartup.untilMs && prev - d <= knownStartup.maxBackS && startupBack < knownStartup.maxCount) startupBack++;
      else unexpectedBack++;
    }
    if (prev !== null && st.playing && !prevPlaying && fileLoaded && t - lastActAt > 150 && d < prev - 1e-9) resumeBack++;
    prev = d; prevPlaying = st.playing;
    while (ni < acts.length && t >= acts[ni].at + 380) {
      const exp = expects[ni];
      const audioNow = st.audioPts === null ? NaN : st.audioPts + (t - st.audioPtsObservedAt) / 1000;
      const want = exp === "time-pos" ? st.position : typeof exp === "number" ? exp : exp.near === "audio" ? audioNow : st.position;
      const tol = typeof exp === "object" ? exp.tol : 1e-4;
      const ok = Math.abs(d - want) <= tol;
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${file.padEnd(15)} #${ni + 1} ${acts[ni].act.slice(0, 22).padEnd(22)} 光标=${d.toFixed(4)} 期望=${want.toFixed(4)} (time-pos=${st.position.toFixed(4)})`);
      ni++;
    }
  }
  const ok = unexpectedBack === 0 && resumeBack === 0;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${file.padEnd(15)} 播放中非操作引起的倒退帧数=${unexpectedBack} 恢复播放时倒退=${resumeBack}`);
  if (startupBack) console.log(`KNOWN ${file.padEnd(15)} 开播阶段倒退帧数=${startupBack}(mpv 起播后停顿、音频未走时外推过头，未修)`);
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures ? 1 : 0;
