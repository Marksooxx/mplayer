import { useEffect, useState } from "react";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { getPeaks, toDb, type PeaksData } from "../lib/peaks";

/**
 * 文件级 L/R 峰值显示
 * loadfile 之后跑一次 symphonia 全文件解码（复用 WaveformStrip 的 calculate_peaks
 * 命令 + 共享 LRU 缓存），把每声道整文件 abs peak 转 dBFS 静态显示。
 *
 * - stereo: 两行 L/R bar + dB
 * - mono: 单行 M bar + dB（容器固定 36px 高度，垂直居中，不抖动）
 * - bar 范围 -60 → 0 dBFS；颜色梯度 绿 / 黄(-12) / 红(-3)
 * - 缓存命中时无 loading 闪烁
 */

const MIN_DB = -60;
const MAX_DB = 0;
const BAR_WIDTH_PX = 70;

/** dB → bar 填充百分比（0–100），clamp 到 [MIN_DB, MAX_DB] */
function barPercent(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
  return ((clamped - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
}

/** dB → bar 颜色 */
function barColor(db: number): string {
  if (!Number.isFinite(db)) return "hsl(140, 30%, 35%)"; // 静音：暗绿
  if (db < -12) return "hsl(140, 60%, 50%)"; // 绿
  if (db < -3) return "hsl(40, 80%, 55%)"; // 黄
  return "hsl(0, 75%, 55%)"; // 红
}

/** dB → 文本，-Infinity 显示 -∞ */
function formatDb(db: number): string {
  if (!Number.isFinite(db)) return "-∞ dB";
  return `${db.toFixed(1)} dB`;
}

function Row({ label, db }: { label: string; db: number }) {
  return (
    <div className="flex items-center gap-1.5 leading-none">
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
      <span className="text-[10px] tabular-nums text-white/75 w-12 text-right">
        {formatDb(db)}
      </span>
    </div>
  );
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: PeaksData }
  | { kind: "failed" };

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

  // 固定外框尺寸 —— mono/stereo/loading/failed 共用同一外形，不抖动
  const frame = "shrink-0 h-9 flex flex-col justify-center px-2";

  if (state.kind === "idle") {
    return <div className={frame} style={{ width: 140 }} aria-hidden />;
  }

  if (state.kind === "loading") {
    return (
      <div
        className={`${frame} text-[10px] text-white/40 items-start`}
        style={{ width: 140 }}
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
        className={`${frame} text-[11px] text-white/35 items-start`}
        style={{ width: 140 }}
        title="无音频流或解码失败"
      >
        —
      </div>
    );
  }

  const { data } = state;
  const dbL = toDb(data.peakL);
  const isStereo = data.peakR !== null && data.channels >= 2;

  if (!isStereo) {
    // mono：单行垂直居中，外框高度保持 36px 不变
    return (
      <div className={`${frame} items-start`} style={{ width: 140 }}>
        <Row label="M" db={dbL} />
      </div>
    );
  }

  const dbR = toDb(data.peakR ?? 0);
  return (
    <div
      className={`${frame} items-start gap-0.5`}
      style={{ width: 140 }}
      title={`文件级峰值\nL: ${formatDb(dbL)}\nR: ${formatDb(dbR)}`}
    >
      <Row label="L" db={dbL} />
      <Row label="R" db={dbR} />
    </div>
  );
}
