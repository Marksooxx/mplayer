import type { PeaksData } from "./peaks";

/**
 * 波形条的唯一时间轴（§6.32）。
 *
 * 光标、已播放填色、点击 seek、peaks 摆放全部走这里的同一组映射：
 *   x = clamp(t / axis, 0, 1) × W，  t = clamp(x / W, 0, 1) × axis
 * axis 与 ControlBar 进度条同源 = mpv duration；peaks 按自带的 startTime /
 * framesPerPeak 摆到真实时间上：音频晚于容器起点 → 左侧留空，音频短于
 * 视频 → 右侧留空，priming / 尾部 padding 落在 [0, axis] 之外 → 被裁掉。
 * 不再把 peaks 拉伸铺满整宽（旧实现的比例漂移源）。
 */

/**
 * 时间轴长度（秒）。mpv duration 只在 fileLoaded 后才可信 —— 切文件瞬间
 * store.duration 可能还是上一个文件的值；此前用 peaks 自身的结束时刻兜底。
 */
export function axisDuration(
  mpvDuration: number,
  fileLoaded: boolean,
  pk: PeaksData | null,
): number {
  if (fileLoaded && mpvDuration > 0) return mpvDuration;
  if (!pk || pk.sampleRate <= 0) return 0;
  return Math.max(0, pk.startTime + pk.totalFrames / pk.sampleRate);
}

export function timeToFrac(t: number, axis: number): number {
  if (!(axis > 0) || !Number.isFinite(t)) return 0;
  return Math.min(1, Math.max(0, t / axis));
}

export function fracToTime(frac: number, axis: number): number {
  if (!(axis > 0)) return 0;
  return Math.min(1, Math.max(0, frac)) * axis;
}

/**
 * 把 peaks 按真实时间重采样到 nBins 个等宽时间格（格 j 覆盖
 * [j, j+1)·axis/nBins），每格取与之重叠的所有桶的 max(|max|, |min|)。
 * 没有音频数据的格为 0。返回新数组（wavesurfer 会原地 normalize 传入的数组，
 * 不能把缓存里的数据直接交给它）。
 */
export function resamplePeaks(
  pk: PeaksData,
  axis: number,
  nBins: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(nBins)));
  const nBuckets = Math.floor(pk.peaks.length / 2);
  if (out.length === 0 || !(axis > 0) || nBuckets === 0) return out;
  const bucketSecs = pk.framesPerPeak / pk.sampleRate;
  if (!(bucketSecs > 0)) return out;
  const binSecs = axis / out.length;
  // 真实音频结尾：最后一桶可能不满，不能按整桶宽度涂到结尾之后
  const endT = pk.startTime + pk.totalFrames / pk.sampleRate;

  for (let j = 0; j < out.length; j++) {
    const t0 = j * binSecs;
    if (t0 >= endT) break;
    const t1 = t0 + binSecs;
    // 与 [t0, t1) 相交的桶：桶 i 覆盖 [start + i·b, start + (i+1)·b)
    let i0 = Math.floor((t0 - pk.startTime) / bucketSecs);
    let i1 = Math.ceil((t1 - pk.startTime) / bucketSecs) - 1;
    if (i0 < 0) i0 = 0;
    if (i1 > nBuckets - 1) i1 = nBuckets - 1;
    let amp = 0;
    for (let i = i0; i <= i1; i++) {
      const mx = Math.abs(pk.peaks[2 * i]);
      const mn = Math.abs(pk.peaks[2 * i + 1]);
      if (mx > amp) amp = mx;
      if (mn > amp) amp = mn;
    }
    out[j] = amp;
  }
  return out;
}
