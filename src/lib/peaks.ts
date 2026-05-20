import { invoke } from "@tauri-apps/api/core";

/**
 * Rust `peaks::calculate_peaks` 命令的返回值。
 * - peaks: WaveSurfer 风格的交替 max/min 数组
 * - peakL/peakR/peakOverall: 整文件每声道 abs 峰值（线性 0..~1+）
 *   mono 文件 peakR === null
 */
export interface PeaksData {
  peaks: number[];
  duration: number;
  sampleRate: number;
  channels: number;
  /** 解码后样本位深；lossy 编码（MP3/AAC/Opus/Vorbis）为 null */
  bitDepth: number | null;
  peakL: number;
  peakR: number | null;
  peakOverall: number;
}

// 简易 LRU，key = filePath::samplesPerPixel
// WaveformStrip 和 LevelMeter 共用这一个 cache —— 一次解码两个组件分享。
const cache = new Map<string, PeaksData>();
const MAX_CACHE = 20;

export async function getPeaks(
  filePath: string,
  samplesPerPixel: number,
): Promise<PeaksData> {
  const key = `${filePath}::${samplesPerPixel}`;
  const cached = cache.get(key);
  if (cached) {
    // LRU 触发：删后插，保持插入顺序即访问顺序
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const data = await invoke<PeaksData>("calculate_peaks", {
    filePath,
    samplesPerPixel,
  });
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, data);
  return data;
}

/**
 * 线性 abs peak → dBFS。
 * peak ≤ 0 时返回 -Infinity（完全静音）。
 * 浮点 PCM 偶尔 > 1.0，转出来是 > 0 dBFS（inter-sample peak）。
 */
export function toDb(peakAbs: number): number {
  if (peakAbs <= 0) return -Infinity;
  return 20 * Math.log10(peakAbs);
}
