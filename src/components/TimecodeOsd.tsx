import { useRef } from "react";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { useVirtualPlayhead } from "../hooks/useCursorAnimation";

/**
 * 时间码 / 帧号 OSD —— 视频区左上角常驻小浮层。
 *
 * - 时间显示到毫秒,帧号 = round(displayed × fps),与 GotoFrameDialog 的
 *   "当前帧"换算完全一致(同 fps 来源、同取整)。
 * - 数据源是虚拟播放头(useVirtualPlayhead),与进度条 / 波形光标同一时钟
 *   同一帧,天然 1:1。
 * - rAF 高频更新走 textContent 直写,零 React 重渲染(与 ProgressFill
 *   同款模式);fps 变化低频,走正常 React 订阅。
 * - 纯音频(fps=0)只显示时间。
 * - 默认快捷键 T 切换,设置面板「界面」也有开关;状态持久化。
 */

function formatOsdTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const ms = Math.floor((seconds % 1) * 1000);
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const base = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return `${base}.${ms.toString().padStart(3, "0")}`;
}

function OsdPanel() {
  const fps = usePlayerStore((s) => s.fps);
  const timeRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<HTMLSpanElement>(null);
  // rAF 回调经 ref 读最新 fps,避免回调闭包过期
  const fpsRef = useRef(fps);
  fpsRef.current = fps;

  useVirtualPlayhead((displayed) => {
    const t = Math.max(0, displayed);
    if (timeRef.current) timeRef.current.textContent = formatOsdTime(t);
    const f = fpsRef.current;
    if (frameRef.current && f > 0) {
      frameRef.current.textContent = Math.round(t * f).toString();
    }
  });

  return (
    <div className="fixed top-12 left-3 z-[90] flex items-center gap-2 px-2.5 py-1 rounded-md bg-black/70 border border-white/15 font-mono text-xs leading-5 text-white/90 pointer-events-none select-none tabular-nums">
      <span ref={timeRef}>00:00.000</span>
      {fps > 0 && (
        <span className="text-white/45">
          帧 <span ref={frameRef} className="text-primary-300">0</span>
        </span>
      )}
    </div>
  );
}

export function TimecodeOsd() {
  const show = useSettingsStore((s) => s.showTimecodeOsd);
  const fileLoaded = usePlayerStore((s) => s.fileLoaded);
  if (!show || !fileLoaded) return null;
  return <OsdPanel />;
}
