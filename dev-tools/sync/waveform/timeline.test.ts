// waveTimeline.resamplePeaks：脉冲落在正确的像素格、留空 / 裁剪正确
import { resamplePeaks, axisDuration, timeToFrac, fracToTime } from "../../../src/lib/waveTimeline.ts";
import { audioIndexOf } from "../../../src/lib/peaks.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };

/** 造 peaks：decodedSecs 长、脉冲在解码时间 spikes[]（秒）处 */
function mk(sr: number, fpp: number, decodedSecs: number, startTime: number, spikes: number[]) {
  const totalFrames = Math.round(decodedSecs * sr);
  const n = Math.ceil(totalFrames / fpp);
  const peaks = new Array(n * 2).fill(0);
  for (const s of spikes) { const i = Math.floor((s * sr) / fpp); peaks[2 * i] = 0.8; peaks[2 * i + 1] = -0.8; }
  return { peaks, framesPerPeak: fpp, totalFrames, startTime, duration: totalFrames / sr, sampleRate: sr, channels: 2, bitDepth: null, peakL: 0.8, peakR: 0.8, peakOverall: 0.8 };
}
const hot = (bins: Float32Array) => [...bins].map((v, i) => (v > 0.5 ? i : -1)).filter((i) => i >= 0);

// AAC m4a：priming 23.22ms 未裁（startTime=-0.02322），脉冲真实在 1.0/2.5s
{
  const pk = mk(44100, 16, 3.0418, -0.02322, [1.02322, 2.52322]);
  const bins = resamplePeaks(pk, 3.0, 1200);
  const h = hot(bins); // 脉冲恰在格边界 1.0s/2.5s 上，所在的 0.36ms 桶跨两格
  check("AAC priming：脉冲落在 1.0s/2.5s 的格(含边界相邻格)", h.includes(400) && h.includes(1000) && h.every((i) => [399, 400, 999, 1000].includes(i)), `hot=${h}`);
}
// 音频晚于视频 0.5s 起播：前 0.5s 留空
{
  const pk = mk(48000, 16, 3.0, 0.5, [1.0]);
  const bins = resamplePeaks(pk, 3.5, 1400);
  check("音轨起点 0.5s：脉冲在 1.5s 格", JSON.stringify(hot(bins)) === JSON.stringify([600]), `hot=${hot(bins)}`);
  // 用非零底噪检查留空
  const pk2 = { ...pk, peaks: pk.peaks.map((v) => (v === 0 ? 0.01 : v)) };
  const b2 = resamplePeaks(pk2, 3.5, 1400);
  check("音轨起点 0.5s：前 200 格为空", b2.slice(0, 200).every((v) => v === 0) && b2[201] > 0);
}
// 音频比视频短（mov 3.0 / 3.5）：3.0s 之后留空，不拉伸
{
  const pk = mk(48000, 16, 3.0, 0, [2.5]);
  const pkN = { ...pk, peaks: pk.peaks.map((v) => (v === 0 ? 0.01 : v)) };
  const bins = resamplePeaks(pkN, 3.5, 1400);
  check("音频短于视频：脉冲在 2.5s 格（旧实现会拉伸到 2.917s）", hot(bins)[0] === 1000, `hot=${hot(bins)}`);
  check("音频短于视频：3.0s 之后为空", bins.slice(1201).every((v) => v === 0) && bins[1199] > 0);
}
// 长文件：粗桶(每桶 0.44s) 也不越界、无 NaN
{
  const pk = mk(48000, 16 * 2 ** 10, 7200, 0, [3600]);
  const bins = resamplePeaks(pk, 7200, 1400);
  check("2h 长文件：脉冲格正确、无 NaN", hot(bins).includes(700) && ![...bins].some(Number.isNaN), `hot=${hot(bins)}`);
}
// 边界
{
  const pk = mk(48000, 16, 3.0, 0, [1.0]);
  check("axis<=0 返回全零", resamplePeaks(pk, 0, 100).every((v) => v === 0));
  check("nBins=0 返回空", resamplePeaks(pk, 3, 0).length === 0);
  check("axisDuration：fileLoaded 前用 peaks 结束时刻", Math.abs(axisDuration(99, false, pk) - 3.0) < 1e-9);
  check("axisDuration：fileLoaded 后用 mpv duration", axisDuration(3.5, true, pk) === 3.5);
  check("axisDuration：mpv duration=0 回退 peaks", Math.abs(axisDuration(0, true, { ...pk, startTime: -0.02 }) - 2.98) < 1e-9);
  check("timeToFrac/fracToTime 互逆且钳制", timeToFrac(1.5, 3) === 0.5 && fracToTime(0.5, 3) === 1.5 && timeToFrac(9, 3) === 1 && fracToTime(-1, 3) === 0 && timeToFrac(NaN, 3) === 0);
}
// codex 反例：sampleRate=10、framesPerPeak=4、totalFrames=5 → 真实音频只到 0.5s，末桶不得涂到 0.8s
{
  const pk = { peaks: [0.5, -0.5, 0.5, -0.5], framesPerPeak: 4, totalFrames: 5, startTime: 0, duration: 0.5, sampleRate: 10, channels: 1, bitDepth: null, peakL: 0.5, peakR: null, peakOverall: 0.5 };
  const bins = resamplePeaks(pk, 1.0, 10);
  const lit = [...bins].map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  check("末桶按真实结尾裁剪（只亮 0–0.5s）", JSON.stringify(lit) === JSON.stringify([0, 1, 2, 3, 4]), `lit=${lit}`);
}
// 音轨序号：mpv aid 在音轨中的位置
{
  const tr = (sel: number | null) => [{ id: 1, type: "video", selected: true }, { id: 2, type: "audio", selected: sel === 2 }, { id: 1, type: "audio", selected: sel === 1 }, { id: 1, type: "sub", selected: false }] as any;
  check("audioIndexOf：选中 aid=2 → 1、aid=1 → 0、未选 → 0、空列表 → 0", audioIndexOf(tr(2)) === 1 && audioIndexOf(tr(1)) === 0 && audioIndexOf(tr(null)) === 0 && audioIndexOf([]) === 0);
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures ? 1 : 0;
