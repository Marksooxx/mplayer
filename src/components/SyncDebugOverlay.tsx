import { useRef, useState } from "react";
import {
  getPlayheadDebugInfo,
  useVirtualPlayhead,
} from "../hooks/useCursorAnimation";
import { useSettingsStore } from "../store/settingsStore";

/**
 * 同步误差调试 overlay(默认 Ctrl+Shift+D,可在设置面板重绑;
 * 状态走 settingsStore.syncDebugVisible,不持久化,每次启动关闭)。
 *
 * 把"光标跟音画是不是 1:1"从感觉变成数字:
 *   err   本帧残差 = 外推真值 − displayed(正 = 光标落后真值)
 *   5s    滚动窗口 avg / min / max
 *   obs   position 观测频率(Hz)—— 事件链正常 ~30,靠 1Hz poll 兜底时 ~1
 *   age   最近一次 time-pos 观测的陈旧度
 *   snap  硬 snap 累计次数(频繁增长 = 时钟从动失效,在硬拽)
 *
 * 隐藏时完全不订阅虚拟播放头,零开销。位置在 TimecodeOsd(top-12)之下,
 * 两者同时开启不重叠。
 */

interface ViewStats {
  cur: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  obsHz: number;
  ageMs: number;
  snapCount: number;
}

const WINDOW_MS = 5000; // 统计窗口
const RENDER_INTERVAL_MS = 250; // 文本刷新节流(采样仍是每帧)

function errColor(errMs: number | null): string {
  if (errMs === null) return "text-white/40";
  const a = Math.abs(errMs);
  if (a < 5) return "text-emerald-400";
  if (a < 20) return "text-amber-400";
  return "text-red-400";
}

function fmt(v: number | null, digits = 1): string {
  if (v === null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}`;
}

function SyncDebugPanel() {
  const samplesRef = useRef<{ t: number; err: number }[]>([]);
  const obsSnapshotsRef = useRef<{ t: number; count: number }[]>([]);
  const lastRenderRef = useRef(0);
  const [stats, setStats] = useState<ViewStats | null>(null);

  useVirtualPlayhead(() => {
    const now = performance.now();
    const info = getPlayheadDebugInfo();

    const buf = samplesRef.current;
    if (info.errMs !== null) buf.push({ t: now, err: info.errMs });
    while (buf.length > 0 && now - buf[0].t > WINDOW_MS) buf.shift();

    if (now - lastRenderRef.current < RENDER_INTERVAL_MS) return;
    lastRenderRef.current = now;

    // 观测频率:对比 ~1s 前的计数快照
    const snaps = obsSnapshotsRef.current;
    snaps.push({ t: now, count: info.obsCount });
    while (snaps.length > 0 && now - snaps[0].t > 1200) snaps.shift();
    const oldest = snaps[0];
    const obsHz =
      oldest && now > oldest.t
        ? ((info.obsCount - oldest.count) * 1000) / (now - oldest.t)
        : 0;

    let avg: number | null = null;
    let min: number | null = null;
    let max: number | null = null;
    if (buf.length > 0) {
      let sum = 0;
      min = Infinity;
      max = -Infinity;
      for (const s of buf) {
        sum += s.err;
        if (s.err < min) min = s.err;
        if (s.err > max) max = s.err;
      }
      avg = sum / buf.length;
    }

    setStats({
      cur: info.errMs,
      avg,
      min,
      max,
      obsHz,
      ageMs: info.ageMs,
      snapCount: info.snapCount,
    });
  });

  if (!stats) return null;
  return (
    <div className="fixed top-[5.5rem] left-3 z-[400] px-2.5 py-1.5 rounded-md bg-black/80 border border-white/15 font-mono text-[11px] leading-[1.5] text-white/80 pointer-events-none select-none whitespace-pre tabular-nums">
      <div>
        <span className="text-white/45">err </span>
        <span className={errColor(stats.cur)}>
          {stats.cur === null ? "—(暂停)" : `${fmt(stats.cur)} ms`}
        </span>
      </div>
      <div className="text-white/60">
        {`5s  ${fmt(stats.avg)} / ${fmt(stats.min)} / ${fmt(stats.max)} ms`}
      </div>
      <div className="text-white/45">
        {`obs ${stats.obsHz.toFixed(1)} Hz · age ${Math.min(stats.ageMs, 99999).toFixed(0)} ms · snap ${stats.snapCount}`}
      </div>
    </div>
  );
}

export function SyncDebugOverlay() {
  const visible = useSettingsStore((s) => s.syncDebugVisible);
  if (!visible) return null;
  return <SyncDebugPanel />;
}
