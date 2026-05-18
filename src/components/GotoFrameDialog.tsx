import { useEffect, useRef, useState } from "react";
import { Clapperboard, X } from "lucide-react";
import { useSettingsStore } from "../store/settingsStore";
import { usePlayerStore } from "../store/playerStore";
import { seekAbsolute } from "../lib/mpv";

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
  const totalFrames = validFps > 0 && duration > 0 ? Math.floor(duration * validFps) : 0;
  const currentFrame = validFps > 0 ? Math.round(position * validFps) : 0;

  // 打开时聚焦 input 并填入当前帧
  useEffect(() => {
    if (!open) return;
    setError(null);
    setValue(currentFrame.toString());
    // 等 DOM 渲染
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open, currentFrame]);

  const submit = () => {
    if (validFps <= 0) {
      setError("当前文件无视频帧率（可能是纯音频或未加载完成）");
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      setError("请输入帧号");
      return;
    }
    const frame = parseInt(trimmed, 10);
    if (!Number.isFinite(frame) || frame < 0) {
      setError("帧号必须是非负整数");
      return;
    }
    if (totalFrames > 0 && frame > totalFrames) {
      setError(`超过总帧数 ${totalFrames}`);
      return;
    }
    const target = frame / validFps;
    void seekAbsolute(target);
    close();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div
        className="w-[420px] max-w-[92vw] rounded-lg bg-neutral-900 border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Clapperboard size={16} className="text-primary-400" />
            <h2 className="text-base font-medium text-white">跳转到指定帧</h2>
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
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="px-2 py-1.5 rounded bg-white/5">
              <div className="text-white/40">帧率</div>
              <div className="text-white/90 tabular-nums">
                {validFps > 0 ? validFps.toFixed(3) : "—"}
              </div>
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

          <div>
            <label className="block text-xs text-white/60 mb-1">目标帧号</label>
            <input
              ref={inputRef}
              type="number"
              inputMode="numeric"
              min={0}
              max={totalFrames > 0 ? totalFrames : undefined}
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
              placeholder="例如 12345"
            />
            {error && <div className="mt-1 text-xs text-red-400">{error}</div>}
            <div className="mt-1 text-[11px] text-white/40">
              按 Enter 跳转，Esc 关闭。
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
