import { useEffect, useRef, useState, type RefObject } from "react";
import { Loader2 } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import { usePlayerStore } from "../store/playerStore";
import { seekAbsolute } from "../lib/mpv";
import { audioIndexOf, getPeaks, type PeaksData } from "../lib/peaks";
import {
  axisDuration,
  fracToTime,
  resamplePeaks,
  timeToFrac,
} from "../lib/waveTimeline";
import { useVirtualPlayhead } from "../hooks/useCursorAnimation";

/**
 * 波形上的播放光标。rAF 驱动 left:%，与 ControlBar 进度条同一个虚拟播放头；
 * 横坐标走波形条自己的时间轴（axisRef），与已播放填色、点击 seek 同一映射。
 */
function WaveformCursor({ axisRef }: { axisRef: RefObject<number> }) {
  const ref = useRef<HTMLDivElement>(null);
  useVirtualPlayhead((displayed) => {
    const el = ref.current;
    if (el) el.style.left = `${timeToFrac(displayed, axisRef.current) * 100}%`;
  });
  return (
    <div
      ref={ref}
      className="absolute top-0 bottom-0 w-0.5 bg-primary-300/90 -translate-x-1/2 shadow-[0_0_4px_rgba(99,102,241,0.6)] pointer-events-none"
      style={{ left: "0%" }}
    />
  );
}

interface Props {
  height?: number;
}

/**
 * 底部常驻波形条
 * 走 Rust symphonia 离线解码生成 peaks，避免浏览器 Web Audio 解码失败 / 大文件 OOM。
 * mpv 仍是真实音频源；wavesurfer 只当 canvas 绘制器：不传 url（它内部的 <audio>
 * 没有 src、不加载文件），没有第三个 duration 来源，也不再每帧 seek 媒体元素（§6.32）。
 */
export function WaveformStrip({ height = 60 }: Props) {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const fileLoaded = usePlayerStore((s) => s.fileLoaded);
  const duration = usePlayerStore((s) => s.duration);
  const loadSeq = usePlayerStore((s) => s.loadSeq);
  // mpv 正在播的音轨序号；本文件的音轨表确认之前先不算
  const audioIndex = usePlayerStore((s) =>
    s.fileLoaded && s.tracksKnown ? audioIndexOf(s.tracks) : null,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [loaded, setLoaded] = useState<{
    path: string;
    audioIndex: number;
    seq: number;
    data: PeaksData;
  } | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [widthPx, setWidthPx] = useState(0);

  const item = currentIndex >= 0 ? playlist[currentIndex] : null;
  const path = item?.path;
  // peaks 与路径 / 音轨 / 加载代次绑定：切文件、切音轨、同路径覆盖后重载时，旧 peaks
  // 不会被画到新加载的时间轴上(加载完成前旧图原样保留，见 effect 4)
  const pk =
    loaded &&
    loaded.path === path &&
    (audioIndex === null || loaded.audioIndex === audioIndex) &&
    (!fileLoaded || loaded.seq === loadSeq)
      ? loaded.data
      : null;

  // 唯一时间轴：光标 / 填色 / 点击 seek / peaks 摆放共用（rAF 回调经 ref 读最新值）
  const axis = axisDuration(duration, fileLoaded, pk);
  const axisRef = useRef(0);
  axisRef.current = axis;
  // mpv 时长确认前不接受点击 seek、不画已播放填色（此时的轴只是 peaks 自身长度）
  const axisConfirmed = fileLoaded && duration > 0;
  const axisConfirmedRef = useRef(false);
  axisConfirmedRef.current = axisConfirmed;

  // 1) 取 peaks。依赖 loadSeq：同一路径被覆盖后重导出再打开(§6.31 场景)也会重取；
  //    同一文件同一音轨的重取静默进行，保留旧波形直到新结果到达(命中缓存时不闪)。
  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setLoading(false);
      setFailed(null);
      return;
    }
    const prev = loadedRef.current;
    // 音轨表确认之前不选音轨：同一路径重载时旧图原样保留；新路径先预热首条音轨的
    // 缓存(绝大多数文件只有一条音轨，确认后命中缓存即可显示)，但不显示
    if (audioIndex === null) {
      if (!(prev && prev.path === path)) {
        setLoading(true);
        setFailed(null);
        void getPeaks(path, 0).catch(() => { /* 确认音轨后会按正确序号重取并报错 */ });
      }
      return;
    }
    const idx = audioIndex;
    const same = prev !== null && prev.path === path && prev.audioIndex === idx;
    // 同一文件同一音轨重取(重载)：不显示"解码中"，命中缓存时几毫秒内就有结果
    if (!same) {
      setLoading(true);
      setFailed(null);
    }
    getPeaks(path, idx)
      .then((data) => {
        if (cancelled) return;
        setLoaded((cur) =>
          cur && cur.path === path && cur.audioIndex === idx && cur.seq === loadSeq && cur.data === data
            ? cur
            : { path, audioIndex: idx, seq: loadSeq, data },
        );
        setLoading(false);
        setFailed(null);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[waveform] peaks calc failed", err);
        if (cancelled) return;
        setLoading(false);
        setFailed(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [path, audioIndex, loadSeq]);

  // 2) 跟踪容器宽度：每 CSS px 一个时间格
  const hasItem = !!item;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidthPx((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasItem]);

  // 3) wavesurfer 实例：随容器挂载创建，height 变化重建
  const drawnRef = useRef<PeaksData | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ws = WaveSurfer.create({
      container: el,
      waveColor: "rgba(255, 255, 255, 0.35)",
      progressColor: "#6366f1",
      cursorWidth: 0, // 只保留 <WaveformCursor />，避免两根锚点不同的光标
      height,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: false, // 我们自己监听 click → mpv seek
    });
    wsRef.current = ws;
    drawnRef.current = null;
    return () => {
      wsRef.current = null;
      try { ws.destroy(); } catch { /* ignore */ }
    };
  }, [hasItem, height]);

  // 4) 按时间把 peaks 摆到时间轴上再交给 wavesurfer 画。
  // 用 load('', …) 而不是 setOptions：7.12.7 的 setOptions 重绘的是旧 audioData。
  // mpv 时间轴确认前不按猜测的轴画(视频 / 晚起播文件会在 file-loaded 时横向跳一次)：
  // 同一份 peaks 已经画着就保持(同文件重载不闪)，否则先空着。
  const axisKey = Math.round(axis * 1000);
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const axisSecs = axisKey / 1000;
    if (!pk || !(axisSecs > 0) || widthPx <= 0) {
      ws.empty();
      drawnRef.current = null;
      return;
    }
    if (!fileLoaded) {
      if (drawnRef.current !== pk) {
        ws.empty();
        drawnRef.current = null;
      }
      return;
    }
    const bins = resamplePeaks(pk, axisSecs, widthPx);
    drawnRef.current = pk;
    ws.load("", [bins], axisSecs).catch((err) => {
      console.warn("[waveform] render failed", err);
    });
  }, [pk, axisKey, widthPx, height, hasItem, fileLoaded]);

  // 已播放填色：与光标同一个虚拟播放头、同一个 axisRef，逐帧直写 renderer
  useVirtualPlayhead((displayed) => {
    const ws = wsRef.current;
    if (!ws) return;
    ws.getRenderer().renderProgress(
      axisConfirmedRef.current ? timeToFrac(displayed, axisRef.current) : 0,
    );
  });

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const axisSecs = axisRef.current;
    if (!axisConfirmedRef.current || axisSecs <= 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    void seekAbsolute(fracToTime((e.clientX - rect.left) / rect.width, axisSecs));
  };

  if (!item) return null;

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
      {/* 与 containerRef 同一区域的光标层：rAF 子组件接管，不依赖父组件 progress 变化重渲染 */}
      {!loading && !failed && fileLoaded && (
        <div className="absolute inset-x-4 inset-y-0 pointer-events-none">
          <WaveformCursor axisRef={axisRef} />
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
