import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import WaveSurfer from "wavesurfer.js";
import { usePlayerStore } from "../store/playerStore";
import { seekAbsolute } from "../lib/mpv";

interface PeaksData {
  peaks: number[];
  duration: number;
  sampleRate: number;
  channels: number;
}

// 简易 LRU peaks 缓存 (key = filePath::samplesPerPixel)
const peaksCache = new Map<string, PeaksData>();
const MAX_CACHE = 20;

async function getPeaks(filePath: string, samplesPerPixel: number): Promise<PeaksData> {
  const key = `${filePath}::${samplesPerPixel}`;
  const cached = peaksCache.get(key);
  if (cached) {
    // LRU 触发：先删后插，保持插入顺序就是访问顺序
    peaksCache.delete(key);
    peaksCache.set(key, cached);
    return cached;
  }
  const data = await invoke<PeaksData>("calculate_peaks", {
    filePath,
    samplesPerPixel,
  });
  if (peaksCache.size >= MAX_CACHE) {
    const firstKey = peaksCache.keys().next().value;
    if (firstKey !== undefined) peaksCache.delete(firstKey);
  }
  peaksCache.set(key, data);
  return data;
}

interface Props {
  height?: number;
  samplesPerPixel?: number;
}

/**
 * 底部常驻波形条
 * 走 Rust symphonia 离线解码生成 peaks，避免浏览器 Web Audio 解码失败 / 大文件 OOM。
 * mpv 仍是真实音频源；wavesurfer 仅做可视化 + click seek。
 */
export function WaveformStrip({ height = 60, samplesPerPixel = 512 }: Props) {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const fileLoaded = usePlayerStore((s) => s.fileLoaded);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  // 用户正在拖动进度条时，光标立即跟随目标位置；松手后清空，回归 mpv 真实进度。
  const dragPosition = usePlayerStore((s) => s.dragPosition);
  const displayPosition = dragPosition ?? position;

  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [peakDuration, setPeakDuration] = useState(0);

  const item = currentIndex >= 0 ? playlist[currentIndex] : null;
  const path = item?.path;

  useEffect(() => {
    let cancelled = false;
    setFailed(null);

    const cleanup = () => {
      if (wsRef.current) {
        try { wsRef.current.destroy(); } catch { /* ignore */ }
        wsRef.current = null;
      }
    };

    if (!path || !containerRef.current) {
      cleanup();
      setPeakDuration(0);
      return;
    }

    setLoading(true);

    (async () => {
      try {
        const data = await getPeaks(path, samplesPerPixel);
        if (cancelled) return;
        setPeakDuration(data.duration);

        cleanup();
        if (!containerRef.current) return;

        const ws = WaveSurfer.create({
          container: containerRef.current,
          waveColor: "rgba(255, 255, 255, 0.35)",
          progressColor: "#6366f1",
          cursorColor: "rgba(255, 255, 255, 0.85)",
          cursorWidth: 2,
          height,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          normalize: true,
          interact: false, // 我们自己监听 click → mpv seek
          // 用 Tauri asset 协议给 media 元素，便于 ws 内部用 setTime 推进进度。
          // 即使 media 解码失败（mkv 等），peaks 已经预渲染，不影响视觉。
          url: convertFileSrc(path),
          peaks: [data.peaks],
          duration: data.duration,
        });
        wsRef.current = ws;

        ws.on("error", (err) => {
          console.warn("[wavesurfer] media error (non-fatal, peaks already rendered)", err);
        });

        if (cancelled) {
          ws.destroy();
          wsRef.current = null;
          return;
        }

        setLoading(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[waveform] peaks calc failed", err);
        if (!cancelled) {
          setLoading(false);
          setFailed(msg);
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [path, height, samplesPerPixel]);

  // 同步 mpv 进度到 wavesurfer 光标 + 进度填色
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const dur = duration > 0 ? duration : peakDuration;
    if (dur <= 0) return;
    try {
      ws.setTime(Math.max(0, Math.min(displayPosition, dur)));
    } catch {
      /* swallow setTime errors when media not ready */
    }
  }, [displayPosition, duration, peakDuration]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const dur = duration > 0 ? duration : peakDuration;
    if (dur <= 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const target = ratio * dur;
    void seekAbsolute(target);
  };

  if (!item) return null;

  const dur = duration > 0 ? duration : peakDuration;
  const progress = dur > 0 ? Math.min(1, displayPosition / dur) : 0;

  return (
    <div
      className="relative w-full bg-neutral-950 border-t border-white/5 select-none"
      style={{ height }}
    >
      {/* 使用 inset-x-4 与 ControlBar 的 px-4 内边距对齐，保证波形宽度与下方进度条一致 */}
      <div
        ref={containerRef}
        className="absolute inset-x-4 inset-y-0 cursor-pointer"
        onClick={handleClick}
        title="点击跳转到该位置"
      />
      {/* 与 containerRef 同一区域的光标层：left:% 直接相对该区域，无需 + padding 偏移
          非拖动时加 100ms 线性过渡，消除 mpv 离散 time-pos 步进的"瞬移"感 */}
      {!loading && !failed && fileLoaded && (
        <div className="absolute inset-x-4 inset-y-0 pointer-events-none">
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-primary-300/90 -translate-x-1/2 shadow-[0_0_4px_rgba(99,102,241,0.6)]"
            style={{
              left: `${progress * 100}%`,
              transition: dragPosition !== null ? "none" : "left 100ms linear",
            }}
          />
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-white/50 text-xs bg-neutral-950 pointer-events-none">
          <Loader2 size={14} className="animate-spin" />
          波形解码中（Rust symphonia）...
        </div>
      )}
      {failed && (
        <div
          className="absolute inset-0 flex items-center justify-center text-white/40 text-xs pointer-events-none px-3"
          title={failed}
        >
          波形不可用（{failed.slice(0, 80)}）
        </div>
      )}
    </div>
  );
}
