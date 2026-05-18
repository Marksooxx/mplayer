import { useEffect, useRef, useState } from "react";
import { Clapperboard, Clock, X } from "lucide-react";
import { useSettingsStore } from "../store/settingsStore";
import { usePlayerStore } from "../store/playerStore";
import { seekAbsolute } from "../lib/mpv";
import { formatTime } from "../lib/format";

/**
 * 跳转弹窗。
 * - 有视频帧率（fps > 0）：按帧号跳转，显示当前帧 / 总帧数 / 帧率
 * - 无视频帧率（纯音频 / 未加载）：降级为按时间跳转 mm:ss 或 hh:mm:ss
 */
export function GotoFrameDialog() {
  const open = useSettingsStore((s) => s.gotoFrameOpen);
  const close = useSettingsStore((s) => s.closeGotoFrame);
  const fps = usePlayerStore((s) => s.fps);
  const duration = usePlayerStore((s) => s.duration);
  const position = usePlayerStore((s) => s.position);
  const currentName = usePlayerStore((s) => {
    const it = s.currentIndex >= 0 ? s.playlist[s.currentIndex] : null;
    return it?.name ?? "";
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const validFps = fps > 0 ? fps : 0;
  const isFrameMode = validFps > 0;
  const totalFrames = isFrameMode && duration > 0 ? Math.floor(duration * validFps) : 0;
  const currentFrame = isFrameMode ? Math.round(position * validFps) : 0;

  // 打开时填充并聚焦
  useEffect(() => {
    if (!open) return;
    setError(null);
    setValue(isFrameMode ? currentFrame.toString() : formatTime(position));
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open, isFrameMode, currentFrame, position]);

  /** "1:23" / "01:23" / "1:23:45" / 纯秒数 都接受 */
  const parseTimeInput = (s: string): number | null => {
    const trimmed = s.trim();
    if (!trimmed) return null;
    // hh:mm:ss or mm:ss
    if (trimmed.includes(":")) {
      const parts = trimmed.split(":").map((p) => p.trim());
      if (parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return null;
      const nums = parts.map(Number);
      let secs = 0;
      if (nums.length === 2) secs = nums[0] * 60 + nums[1];
      else if (nums.length === 3) secs = nums[0] * 3600 + nums[1] * 60 + nums[2];
      else return null;
      return Number.isFinite(secs) ? secs : null;
    }
    // pure seconds
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(isFrameMode ? "请输入帧号" : "请输入时间");
      return;
    }
    if (isFrameMode) {
      const frame = parseInt(trimmed, 10);
      if (!Number.isFinite(frame) || frame < 0) {
        setError("帧号必须是非负整数");
        return;
      }
      if (totalFrames > 0 && frame > totalFrames) {
        setError(`超过总帧数 ${totalFrames}`);
        return;
      }
      void seekAbsolute(frame / validFps);
    } else {
      const secs = parseTimeInput(trimmed);
      if (secs === null) {
        setError('时间格式：mm:ss 或 hh:mm:ss（如 "1:23" / "0:45.5"）');
        return;
      }
      if (duration > 0 && secs > duration) {
        setError(`超过总时长 ${formatTime(duration)}`);
        return;
      }
      void seekAbsolute(secs);
    }
    close();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 anim-fade-in"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div
        className="w-[420px] max-w-[92vw] rounded-lg bg-neutral-900 border border-white/10 shadow-2xl anim-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            {isFrameMode ? (
              <Clapperboard size={16} className="text-primary-400" />
            ) : (
              <Clock size={16} className="text-primary-400" />
            )}
            <h2 className="text-base font-medium text-white">
              {isFrameMode ? "跳转到指定帧" : "跳转到指定时间"}
            </h2>
          </div>
          <button
            onClick={close}
            className="p-1 rounded hover:bg-white/10 text-white/70"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-xs text-white/50 truncate" title={currentName}>
            {currentName || "未加载文件"}
          </div>
          {isFrameMode ? (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="px-2 py-1.5 rounded bg-white/5">
                <div className="text-white/40">帧率</div>
                <div className="text-white/90 tabular-nums">{validFps.toFixed(3)}</div>
              </div>
              <div className="px-2 py-1.5 rounded bg-white/5">
                <div className="text-white/40">当前帧</div>
                <div className="text-white/90 tabular-nums">{currentFrame}</div>
              </div>
              <div className="px-2 py-1.5 rounded bg-white/5">
                <div className="text-white/40">总帧数</div>
                <div className="text-white/90 tabular-nums">
                  {totalFrames > 0 ? totalFrames : "—"}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="px-2 py-1.5 rounded bg-white/5">
                <div className="text-white/40">当前位置</div>
                <div className="text-white/90 tabular-nums">{formatTime(position)}</div>
              </div>
              <div className="px-2 py-1.5 rounded bg-white/5">
                <div className="text-white/40">总时长</div>
                <div className="text-white/90 tabular-nums">{formatTime(duration)}</div>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs text-white/60 mb-1">
              {isFrameMode ? "目标帧号" : "目标时间（mm:ss 或 hh:mm:ss）"}
            </label>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              className="w-full px-3 py-2 rounded bg-neutral-800 border border-white/10 focus:border-primary-400 outline-none text-white tabular-nums"
              placeholder={isFrameMode ? "例如 12345" : "例如 1:23 或 0:45.5"}
            />
            {error && <div className="mt-1 text-xs text-red-400">{error}</div>}
            <div className="mt-1 text-[11px] text-white/40">
              按 Enter 跳转，Esc 关闭。
              {!isFrameMode && " 当前为纯音频/无帧率信息，已切到时间模式。"}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/10">
          <button
            type="button"
            onClick={close}
            className="h-8 px-3 rounded text-sm text-white/70 hover:bg-white/10"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            className="h-8 px-3 rounded bg-primary-500 hover:bg-primary-400 text-white text-sm"
          >
            跳转
          </button>
        </div>
      </div>
    </div>
  );
}
