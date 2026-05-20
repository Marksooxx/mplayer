import { useEffect, useState } from "react";
import { Eraser, Keyboard, RotateCcw, X } from "lucide-react";
import { clearAllPositions, countSavedPositions } from "../lib/persist";
import { useSettingsStore } from "../store/settingsStore";
import {
  ACTION_LABELS,
  ACTION_ORDER,
  FRAME_STEP_MAX,
  FRAME_STEP_MIN,
  displayCombo,
  eventToCombo,
  isPureModifier,
  type ShortcutAction,
} from "../lib/shortcuts";

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  // 开关视觉:开 = primary 实心 + 白色 thumb + 微发光环;关 = 深灰底 + 暗灰 thumb。
  // 旧实现 w-10 h-5 + bg-white/20 关态在深色面板上几乎无对比;放大到 w-12 h-6 +
  // ring 区分 + thumb 颜色差异化,远距离一眼看清状态。
  return (
    <label className="flex items-start justify-between gap-3 p-3 rounded-md hover:bg-white/5 cursor-pointer">
      <div className="flex-1">
        <div className="text-sm text-white/90">{label}</div>
        {description && <div className="text-xs text-white/50 mt-0.5">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 w-12 h-6 rounded-full transition-colors ring-1 ring-inset ${
          checked
            ? "bg-primary-500 ring-primary-300/70 shadow-[0_0_0_3px_rgba(99,102,241,0.18)]"
            : "bg-neutral-800 ring-white/20"
        }`}
        aria-label={checked ? "已开启" : "已关闭"}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-all shadow-md ${
            checked
              ? "translate-x-6 bg-white"
              : "translate-x-0 bg-neutral-400"
          }`}
        />
      </button>
    </label>
  );
}

function ClearPositionsButton() {
  const [count, setCount] = useState(() => countSavedPositions());
  const [justCleared, setJustCleared] = useState(false);

  const handleClear = () => {
    clearAllPositions();
    setCount(0);
    setJustCleared(true);
    setTimeout(() => setJustCleared(false), 1500);
  };

  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-md hover:bg-white/5">
      <div className="flex-1">
        <div className="text-sm text-white/90">清空已保存的播放进度</div>
        <div className="text-xs text-white/50 mt-0.5">
          {justCleared
            ? "已清空。所有文件下次打开都将从头开始。"
            : `当前有 ${count} 条已保存的进度。点击清空后所有文件下次打开从头开始。`}
        </div>
      </div>
      <button
        type="button"
        onClick={handleClear}
        disabled={count === 0 && !justCleared}
        className="shrink-0 inline-flex items-center gap-1 h-8 px-3 rounded text-xs text-white/85 border border-white/15 hover:border-red-400 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Eraser size={13} /> 清空
      </button>
    </div>
  );
}

function ShortcutRow({ action }: { action: ShortcutAction }) {
  const combo = useSettingsStore((s) => s.shortcuts[action]);
  const recording = useSettingsStore((s) => s.recordingAction === action);
  const beginRecording = useSettingsStore((s) => s.beginRecording);
  const setShortcut = useSettingsStore((s) => s.setShortcut);

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 rounded hover:bg-white/5">
      <span className="text-sm text-white/85">{ACTION_LABELS[action]}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => beginRecording(action)}
          className={`min-w-[130px] h-7 px-2 rounded text-xs tabular-nums border transition-colors ${
            recording
              ? "border-primary-400 bg-primary-500/20 text-primary-200 animate-pulse"
              : combo
                ? "border-white/15 bg-white/5 text-white/90 hover:border-white/30"
                : "border-dashed border-white/20 text-white/40 hover:border-white/40"
          }`}
        >
          {recording ? "请按键…（Esc 取消）" : displayCombo(combo)}
        </button>
        {combo && !recording && (
          <button
            type="button"
            title="清除"
            onClick={() => setShortcut(action, "")}
            className="w-7 h-7 inline-flex items-center justify-center rounded text-white/40 hover:text-white/80 hover:bg-white/10"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const open = useSettingsStore((s) => s.settingsOpen);
  const close = useSettingsStore((s) => s.closeSettings);
  const topBarAutoHide = useSettingsStore((s) => s.topBarAutoHide);
  const topBarHidden = useSettingsStore((s) => s.topBarHidden);
  const setTopBarAutoHide = useSettingsStore((s) => s.setTopBarAutoHide);
  const setTopBarHidden = useSettingsStore((s) => s.setTopBarHidden);
  const showWaveform = useSettingsStore((s) => s.showWaveform);
  const setShowWaveform = useSettingsStore((s) => s.setShowWaveform);
  const showLevelMeter = useSettingsStore((s) => s.showLevelMeter);
  const setShowLevelMeter = useSettingsStore((s) => s.setShowLevelMeter);
  const rememberPosition = useSettingsStore((s) => s.rememberPosition);
  const setRememberPosition = useSettingsStore((s) => s.setRememberPosition);
  const frameStepMultiplier = useSettingsStore((s) => s.frameStepMultiplier);
  const setFrameStepMultiplier = useSettingsStore((s) => s.setFrameStepMultiplier);
  const recordingAction = useSettingsStore((s) => s.recordingAction);
  const cancelRecording = useSettingsStore((s) => s.cancelRecording);
  const setShortcut = useSettingsStore((s) => s.setShortcut);
  const resetShortcuts = useSettingsStore((s) => s.resetShortcuts);

  // 录键全局监听：在 capture 阶段拿，避免与全局 KeyboardShortcuts 冲突
  useEffect(() => {
    if (!recordingAction) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        cancelRecording();
        return;
      }
      if (isPureModifier(e.key)) return; // 等待用户再按主键
      const combo = eventToCombo(e);
      setShortcut(recordingAction, combo);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [recordingAction, cancelRecording, setShortcut]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 anim-fade-in"
      onClick={() => {
        cancelRecording();
        close();
      }}
    >
      <div
        className="w-[520px] max-w-[92vw] max-h-[88vh] flex flex-col rounded-lg bg-neutral-900 border border-white/10 shadow-2xl anim-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <h2 className="text-base font-medium text-white">设置</h2>
          <button
            onClick={close}
            className="p-1 rounded hover:bg-white/10 text-white/70"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {/* 界面 */}
          <div className="px-3 py-2 text-xs text-white/40 uppercase tracking-wide">界面</div>
          <Toggle
            label="顶部文件名条悬浮显示"
            description="开启后顶部文件名条默认隐藏，鼠标移到窗口顶部时浮现 2.5 秒后再次隐藏"
            checked={topBarAutoHide && !topBarHidden}
            onChange={(v) => {
              setTopBarHidden(false);
              setTopBarAutoHide(v);
            }}
          />
          <Toggle
            label="完全隐藏顶部文件名条"
            description="关掉浮动显示功能，顶部永远不会出现文件名条"
            checked={topBarHidden}
            onChange={(v) => setTopBarHidden(v)}
          />
          <Toggle
            label="显示底部音频波形条"
            description="ControlBar 上方常驻波形可视化；关闭后释放该区域空间"
            checked={showWaveform}
            onChange={(v) => setShowWaveform(v)}
          />
          <Toggle
            label="显示 L/R 文件级峰值"
            description="loadfile 后在 ControlBar 时间右边显示整文件 L/R 峰值（dBFS），颜色和 bar 直观判断削波风险。关闭后不再解码计算"
            checked={showLevelMeter}
            onChange={(v) => setShowLevelMeter(v)}
          />

          <div className="px-3 py-2 mt-2 text-xs text-white/40 uppercase tracking-wide">播放</div>
          <Toggle
            label="记忆每个文件的上次播放位置"
            description="再次打开同一文件时自动跳转到上次播到的时间（已播完的文件总是从 0 开始）"
            checked={rememberPosition}
            onChange={(v) => setRememberPosition(v)}
          />
          <ClearPositionsButton />
          <div className="flex items-center justify-between gap-3 p-3 rounded-md hover:bg-white/5">
            <div className="flex-1">
              <div className="text-sm text-white/90">Shift+←/→ 步进帧数</div>
              <div className="text-xs text-white/50 mt-0.5">
                介于"裸键 ±5 秒"与"Ctrl 单帧"之间的中档跳转。范围 {FRAME_STEP_MIN} – {FRAME_STEP_MAX}（默认 3）。
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setFrameStepMultiplier(frameStepMultiplier - 1)}
                disabled={frameStepMultiplier <= FRAME_STEP_MIN}
                className="w-7 h-7 rounded text-sm text-white/70 border border-white/15 hover:border-white/40 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
              >
                −
              </button>
              <input
                type="number"
                min={FRAME_STEP_MIN}
                max={FRAME_STEP_MAX}
                value={frameStepMultiplier}
                onChange={(e) => setFrameStepMultiplier(Number(e.target.value))}
                className="w-14 h-7 px-2 text-center text-sm tabular-nums bg-neutral-800 border border-white/10 focus:border-primary-400 outline-none rounded text-white [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button
                type="button"
                onClick={() => setFrameStepMultiplier(frameStepMultiplier + 1)}
                disabled={frameStepMultiplier >= FRAME_STEP_MAX}
                className="w-7 h-7 rounded text-sm text-white/70 border border-white/15 hover:border-white/40 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
              >
                +
              </button>
              <span className="ml-1 text-xs text-white/50">帧</span>
            </div>
          </div>

          {/* 快捷键 */}
          <div className="flex items-center justify-between mt-2 px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs text-white/40 uppercase tracking-wide">
              <Keyboard size={12} /> 键盘快捷键
            </div>
            <button
              type="button"
              onClick={resetShortcuts}
              className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs text-white/60 hover:text-white hover:bg-white/10"
              title="全部恢复默认"
            >
              <RotateCcw size={12} /> 恢复默认
            </button>
          </div>
          <div className="px-1 pb-2">
            {ACTION_ORDER.map((act) => (
              <ShortcutRow key={act} action={act} />
            ))}
          </div>
          <div className="px-3 py-2 text-[11px] text-white/35 leading-relaxed">
            点击按键标签后按下任意组合键即可绑定。同一组合键被绑到多个动作时，旧动作会被自动清空。
            <br />
            清除后该动作不响应任何按键（仍可用控件操作）。
          </div>
        </div>

        <div className="px-4 py-3 border-t border-white/10 text-xs text-white/40 shrink-0">
          mplayer · Tauri 2 + HeroUI v3 + libmpv
        </div>
      </div>
    </div>
  );
}
