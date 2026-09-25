import { invoke } from "@tauri-apps/api/core";
import type { TrackInfo } from "../store/playerStore";

/**
 * Rust `peaks::calculate_peaks` 命令的返回值。
 * - peaks: 每桶交替 [max, min]（跨声道）；第 i 桶覆盖解码帧 [i·fpp, (i+1)·fpp)
 * - startTime: 解码第 0 帧在 mpv 时间轴上的秒数（priming 为负、音轨晚起播为正，§6.32）
 * - peakL/peakR/peakOverall: 整文件每声道 abs 峰值（线性 0..~1+）
 *   mono 文件 peakR === null
 */
export interface PeaksData {
  peaks: number[];
  framesPerPeak: number;
  totalFrames: number;
  startTime: number;
  /** 解码时长（秒）= totalFrames / sampleRate；≠ mpv duration */
  duration: number;
  sampleRate: number;
  channels: number;
  /** 解码后样本位深；lossy 编码（MP3/AAC/Opus/Vorbis）为 null */
  bitDepth: number | null;
  peakL: number;
  peakR: number | null;
  peakOverall: number;
}

// 简易 LRU，key = filePath::v2::a<音轨序号>::size:mtime
// WaveformStrip 和 LevelMeter 共用这一个 cache —— 一次解码两个组件分享。
// 分辨率由 Rust 自适应决定（不再有 spp 参数），两边天然同键。
//
// ★ 键里必须带内容指纹（size+mtime）★
// 只按路径缓存时，同路径文件被重新导出/覆盖（AI 配音工作流常态）会命中
// 旧内容的波形 —— 表现为"新文件的静音区叠着旧波形"（§6.31）。
// stat 由 Rust file_fingerprint 命令完成；失败（文件消失/网络盘抖动）时
// 退化为路径级键，行为与旧版一致。
//
// ★ 进行中请求也要缓存 ★
// file-loaded 时 WaveformStrip 与 LevelMeter 几乎同时请求同一文件；只缓存
// 已完成结果时两边都 miss，会整文件解码两次。
const cache = new Map<string, PeaksData>();
const inflight = new Map<string, Promise<PeaksData>>();
const MAX_CACHE = 20;
const CACHE_VERSION = "v2";

interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

/**
 * mpv 当前选中音轨在音轨中的序号（0 起）—— Rust 按容器顺序取第 N 条音轨，与 mpv 的
 * aid 编号规则一致（§6.32）。依据 track-list 的 selected 标记（start-file 时清空、
 * file-loaded 时主动刷新，不会沿用上一个文件）。未选音轨（aid=no）时取第一条作预览。
 */
export function audioIndexOf(tracks: TrackInfo[]): number {
  const audio = tracks.filter((t) => t.type === "audio").sort((a, b) => a.id - b.id);
  const i = audio.findIndex((t) => t.selected);
  return i < 0 ? 0 : i;
}

export async function getPeaks(filePath: string, audioIndex = 0): Promise<PeaksData> {
  let fp = "";
  try {
    const f = await invoke<FileFingerprint>("file_fingerprint", { filePath });
    fp = `${f.size}:${f.mtimeMs}`;
  } catch {
    /* stat 失败退化为路径级缓存 */
  }
  const key = `${filePath}::${CACHE_VERSION}::a${audioIndex}::${fp}`;
  const cached = cache.get(key);
  if (cached) {
    // LRU 触发：删后插，保持插入顺序即访问顺序
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = invoke<PeaksData>("calculate_peaks", { filePath, audioIndex })
    .then((data) => {
      if (cache.size >= MAX_CACHE) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
      }
      cache.set(key, data);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
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
