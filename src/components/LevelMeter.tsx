import { useEffect, useState } from "react";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { getPeaks, toDb, type PeaksData } from "../lib/peaks";

/**
 * 文件级 L/R 峰值 + 采样率 / 位深显示
 * loadfile 之后跑一次 symphonia 全文件解码（复用 WaveformStrip 的 calculate_peaks
 * 命令 + 共享 LRU 缓存），把每声道整文件 abs peak 转 dBFS 静态显示。
 *
 * 布局（固定 36×220）：
 *   ┌────────────────────────┬────────────┐
 *   │ L  ████░░  -6.2 dB     │  44.1 kHz  │
 *   │ R  ███░░░  -8.5 dB     │  16 bit    │
 *   └────────────────────────┴────────────┘
 * mono 时左半单行垂直居中（不抖动高度），右半始终两行 SR/BD。
 *
 * bar 范围 -60 → 0 dBFS；颜色梯度 绿 / 黄(-12) / 红(-3)。
 * bit_depth 在 lossy 编码（MP3/AAC/Opus）下为 null，显示 "lossy"。
 */

const MIN_DB = -60;
const MAX_DB = 0;
const BAR_WIDTH_PX = 70;

function barPercent(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
  return ((clamped - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
}

function barColor(db: number): string {
  if (!Number.isFinite(db)) return "hsl(140, 30%, 35%)";
  if (db < -12) return "hsl(140, 60%, 50%)";
  if (db < -3) return "hsl(40, 80%, 55%)";
  return "hsl(0, 75%, 55%)";
}

function formatDb(db: number): string {
  if (!Number.isFinite(db)) return "-∞ dB";
  return `${db.toFixed(1)} dB`;
}

/** 44100 → "44.1 kHz", 48000 → "48 kHz" */
function formatSampleRate(sr: number): string {
  const khz = sr / 1000;
  return khz % 1 === 0 ? `${khz} kHz` : `${khz.toFixed(1)} kHz`;
}

function formatBitDepth(bd: number | null): string {
  return bd == null ? "lossy" : `${bd} bit`;
}

function Row({ label, db }: { label: string; db: number }) {
  return (
    <div className="flex items-center gap-1 leading-none">
      <span className="text-[10px] font-medium text-white/50 w-3 text-center">
        {label}
      </span>
      <div
        className="relative h-1.5 rounded-sm bg-white/10 overflow-hidden"
        style={{ width: BAR_WIDTH_PX }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-sm transition-[width,background-color] duration-200"
          style={{
            width: `${barPercent(db)}%`,
            backgroundColor: barColor(db),
          }}
        />
      </div>
      {/* 数字左对齐 → 紧贴 bar 右边；w-12 仍然保留作为最小宽度防止右侧 InfoColumn 抖动 */}
      <span className="text-[10px] tabular-nums text-white/75 w-12 text-left">
        {formatDb(db)}
      </span>
    </div>
  );
}

function InfoColumn({ data }: { data: PeaksData }) {
  // 紧贴左侧 dB 数字：pl-1（4px）、不用 border-l、不留 ml,
  // 仅靠字体颜色淡化作为视觉分隔。
  return (
    <div
      className="flex flex-col justify-center gap-0.5 pl-1 text-[10px] tabular-nums text-white/55 leading-none w-[58px]"
      title={`采样率 ${data.sampleRate} Hz\n位深 ${
        data.bitDepth == null ? "lossy (浮点解码)" : `${data.bitDepth}-bit`
      }\n声道 ${data.channels}`}
    >
      <span>{formatSampleRate(data.sampleRate)}</span>
      <span>{formatBitDepth(data.bitDepth)}</span>
    </div>
  );
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: PeaksData }
  | { kind: "failed" };

const TOTAL_WIDTH = 220;
const FRAME_CLASS = "shrink-0 h-9 flex items-center px-2";

export function LevelMeter() {
  const showLevelMeter = useSettingsStore((s) => s.showLevelMeter);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playlist = usePlayerStore((s) => s.playlist);
  const fileLoaded = usePlayerStore((s) => s.fileLoaded);
  const [state, setState] = useState<State>({ kind: "idle" });

  const path = currentIndex >= 0 ? playlist[currentIndex]?.path : undefined;

  useEffect(() => {
    if (!showLevelMeter) {
      setState({ kind: "idle" });
      return;
    }
    if (!path || !fileLoaded) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    getPeaks(path, 512)
      .then((data) => {
        if (cancelled) return;
        setState({ kind: "ready", data });
      })
      .catch((err) => {
        console.warn("[level-meter] getPeaks failed", err);
        if (cancelled) return;
        setState({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [path, fileLoaded, showLevelMeter]);

  if (!showLevelMeter) return null;

  if (state.kind === "idle") {
    return <div className={FRAME_CLASS} style={{ width: TOTAL_WIDTH }} aria-hidden />;
  }

  if (state.kind === "loading") {
    return (
      <div
        className={`${FRAME_CLASS} text-[10px] text-white/40`}
        style={{ width: TOTAL_WIDTH }}
      >
        <span className="inline-flex gap-0.5">
          <span className="animate-pulse">·</span>
          <span className="animate-pulse [animation-delay:120ms]">·</span>
          <span className="animate-pulse [animation-delay:240ms]">·</span>
          <span className="ml-1">分析峰值</span>
        </span>
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div
        className={`${FRAME_CLASS} text-[11px] text-white/35`}
        style={{ width: TOTAL_WIDTH }}
        title="无音频流或解码失败"
      >
        —
      </div>
    );
  }

  const { data } = state;
  const dbL = toDb(data.peakL);
  const isStereo = data.peakR !== null && data.channels >= 2;

  return (
    <div className={FRAME_CLASS} style={{ width: TOTAL_WIDTH }}>
      {/* 左半:level meter */}
      <div className="flex flex-col justify-center gap-0.5 flex-1">
        {isStereo ? (
          <>
            <Row label="L" db={dbL} />
            <Row label="R" db={toDb(data.peakR ?? 0)} />
          </>
        ) : (
          // mono:单行垂直居中,容器 h-9 + flex-col justify-center 保证不抖动高度
          <Row label="M" db={dbL} />
        )}
      </div>
      {/* 右半:文件元信息 */}
      <InfoColumn data={data} />
    </div>
  );
}
