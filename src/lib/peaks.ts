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

// 简易 LRU，key = filePath::samplesPerPixel::size:mtime
// WaveformStrip 和 LevelMeter 共用这一个 cache —— 一次解码两个组件分享。
//
// ★ 键里必须带内容指纹（size+mtime）★
// 只按路径缓存时，同路径文件被重新导出/覆盖（AI 配音工作流常态）会命中
// 旧内容的波形 —— 表现为"新文件的静音区叠着旧波形"（§6.31）。
// stat 由 Rust file_fingerprint 命令完成；失败（文件消失/网络盘抖动）时
// 退化为路径级键，行为与旧版一致。
const cache = new Map<string, PeaksData>();
const MAX_CACHE = 20;

interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

export async function getPeaks(
  filePath: string,
  samplesPerPixel: number,
): Promise<PeaksData> {
  let fp = "";
  try {
    const f = await invoke<FileFingerprint>("file_fingerprint", { filePath });
    fp = `${f.size}:${f.mtimeMs}`;
  } catch {
    /* stat 失败退化为路径级缓存 */
  }
  const key = `${filePath}::${samplesPerPixel}::${fp}`;
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
