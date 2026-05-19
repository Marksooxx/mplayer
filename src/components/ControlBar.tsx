import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AudioWaveform,
  ChevronFirst,
  ChevronLast,
  Gauge,
  ListMusic,
  Maximize,
  Minimize,
  Pause,
  Pin,
  PinOff,
  Play,
  Repeat,
  Repeat1,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import {
  frameBackStep,
  frameStep,
  seekAbsolute,
  setMutedProp,
  setSpeedProp,
  setVolumeProp,
  togglePause,
} from "../lib/mpv";
import { playNext, playPrev } from "../hooks/useMpv";
import { formatTime } from "../lib/format";
import { TrackMenu } from "./TrackMenu";
import { useCursorAnimation } from "../hooks/useCursorAnimation";

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 进度条已播放填充。rAF 驱动 scaleX，与屏幕同步，0 额外 React 重渲染 */
function ProgressFill() {
  const ref = useRef<HTMLDivElement>(null);
  useCursorAnimation(ref, (el, p) => {
    el.style.transform = `scaleX(${p})`;
  });
  return (
    <div
      ref={ref}
      className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 group-hover:h-2 bg-primary-500 rounded-full origin-left pointer-events-none transition-[height] duration-150"
      style={{ transform: "scaleX(0)", willChange: "transform" }}
    />
  );
}

/** 进度条圆点（thumb）。rAF 驱动 left:%；transform 留给 translate(-50%, -50%) */
function ProgressThumb({ hasMedia }: { hasMedia: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useCursorAnimation(ref, (el, p) => {
    el.style.left = `${p * 100}%`;
  });
  return (
    <div
      ref={ref}
      className="absolute top-1/2 w-3.5 h-3.5 group-hover:w-4 group-hover:h-4 rounded-full bg-white border-2 border-primary-500 shadow-md pointer-events-none transition-[width,height,opacity] duration-150"
      style={{
        left: "0%",
        transform: "translate(-50%, -50%)",
        opacity: hasMedia ? 1 : 0,
      }}
    />
  );
}

function IconBtn({
  onClick,
  label,
  children,
  disabled,
  active,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        active ? "bg-primary-500/30 text-primary-200" : "text-white/85 hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function PlayBtn({ playing, onClick, disabled }: { playing: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={playing ? "暂停" : "播放"}
      title={playing ? "暂停" : "播放"}
      className="shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-full bg-primary-500 hover:bg-primary-400 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-md"
    >
      {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="translate-x-[1px]" />}
    </button>
  );
}

export function ControlBar() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const speed = usePlayerStore((s) => s.speed);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);

  const playlistCollapsed = useSettingsStore((s) => s.playlistCollapsed);
  const togglePlaylist = useSettingsStore((s) => s.togglePlaylist);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const alwaysOnTop = useSettingsStore((s) => s.alwaysOnTop);
  const toggleAlwaysOnTop = useSettingsStore((s) => s.toggleAlwaysOnTop);
  const playbackMode = useSettingsStore((s) => s.playbackMode);
  const cyclePlaybackMode = useSettingsStore((s) => s.cyclePlaybackMode);
  const showWaveform = useSettingsStore((s) => s.showWaveform);
  const setShowWaveform = useSettingsStore((s) => s.setShowWaveform);

  // dragValue 提升到 store，让 WaveformStrip 能跟随拖动实时移动光标
  const dragValue = usePlayerStore((s) => s.dragPosition);
  const setDragValue = usePlayerStore((s) => s.setDragPosition);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; time: number } | null>(null);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [draggingVolume, setDraggingVolume] = useState<number | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const lastVolRef = useRef(volume);

  // 音量 IPC 节流：rAF 合并相邻 mousemove，避免 60+ Hz 打满 IPC
  const volRafRef = useRef<number | null>(null);
  const volPendingRef = useRef<number | null>(null);
  const queueSendVolume = (v: number) => {
    volPendingRef.current = v;
    if (volRafRef.current !== null) return;
    volRafRef.current = requestAnimationFrame(() => {
      volRafRef.current = null;
      if (volPendingRef.current !== null) {
        const target = volPendingRef.current;
        volPendingRef.current = null;
        void setVolumeProp(target);
      }
    });
  };

  useEffect(() => {
    return () => {
      if (volRafRef.current !== null) cancelAnimationFrame(volRafRef.current);
    };
  }, []);

  useEffect(() => {
    if (volume > 0 && !muted) lastVolRef.current = volume;
  }, [volume, muted]);

  const hasMedia = currentIndex >= 0 && duration > 0;
  // displayPos 仅用于时间文字显示；进度条 fill/thumb 由 rAF 驱动的子组件接管
  const displayPos = dragValue ?? position;

  const handlePlayPause = () => {
    if (currentIndex < 0) return;
    void togglePause();
  };

  const handleFullscreen = async () => {
    const win = getCurrentWindow();
    const cur = await win.isFullscreen();
    await win.setFullscreen(!cur);
    setFullscreen(!cur);
  };

  const seekFromMouse = (clientX: number): number | null => {
    const el = progressRef.current;
    if (!el || !hasMedia) return null;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const handleProgressMouseMove = (e: React.MouseEvent) => {
    const t = seekFromMouse(e.clientX);
    if (t === null) return;
    const rect = progressRef.current!.getBoundingClientRect();
    setHoverInfo({ x: e.clientX - rect.left, time: t });
  };

  const handleProgressMouseLeave = () => setHoverInfo(null);

  const handleProgressDown = (e: React.MouseEvent) => {
    if (!hasMedia) return;
    const t = seekFromMouse(e.clientX);
    if (t === null) return;
    setDragValue(t);
    const onMove = (ev: MouseEvent) => {
      const nt = seekFromMouse(ev.clientX);
      if (nt !== null) setDragValue(nt);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const nt = seekFromMouse(ev.clientX);
      const final = nt ?? t;
      void seekAbsolute(final);
      // 略等 mpv time-pos 回报新位置再清掉乐观值，避免视觉上回弹一下
      setTimeout(() => setDragValue(null), 200);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleVolume = (e: React.MouseEvent) => {
    // Ctrl+click 恢复默认音量(80%),不进入拖动模式
    if (e.ctrlKey) {
      void setVolumeProp(80);
      if (muted) void setMutedProp(false);
      return;
    }

    const el = e.currentTarget as HTMLDivElement;
    const rect = el.getBoundingClientRect();
    const computeFromX = (x: number) => {
      const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      return Math.round(ratio * 100);
    };

    const apply = (v: number) => {
      // 1) 立即更新本地 UI 状态（乐观渲染，不等 mpv 回报）
      setDraggingVolume(v);
      // 2) 节流地发 IPC 给 mpv
      queueSendVolume(v);
      if (muted && v > 0) void setMutedProp(false);
    };

    apply(computeFromX(e.clientX));
    const onMove = (ev: MouseEvent) => apply(computeFromX(ev.clientX));
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const finalV = computeFromX(ev.clientX);
      // 终态强制 commit（防止节流吞掉最后一次）
      if (volRafRef.current !== null) {
        cancelAnimationFrame(volRafRef.current);
        volRafRef.current = null;
      }
      volPendingRef.current = null;
      void setVolumeProp(finalV);
      // 略等 IPC 回程更新 store，再清掉乐观值，避免回弹闪烁
      setTimeout(() => setDraggingVolume(null), 200);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleMuteToggle = () => {
    if (muted) {
      void setMutedProp(false);
      if (volume === 0) void setVolumeProp(lastVolRef.current || 50);
    } else {
      void setMutedProp(true);
    }
  };

  // 拖动时优先使用本地状态，避免 mpv 回报往返带来的视觉延迟
  const displayVolume = draggingVolume ?? volume;
  const VolumeIcon = muted || displayVolume === 0 ? VolumeX : displayVolume < 33 ? Volume : displayVolume < 66 ? Volume1 : Volume2;

  return (
    <div
      className="flex flex-col gap-1 px-4 py-2 bg-neutral-950 border-t border-white/10 select-none"
      style={{ zIndex: 20, position: "relative" }}
    >
      {/* Progress bar — HeroUI Slider 视觉风格：轨道常驻、主色填充、圆点常驻 hover 放大
          contain: layout paint —— 隔离 thumb 的 left:% 更新带来的 layout pass,
          不波及外层 ControlBar 的其他元素 */}
      <div
        ref={progressRef}
        className="relative h-5 group cursor-pointer flex items-center"
        style={{ contain: "layout paint" }}
        onMouseDown={handleProgressDown}
        onMouseMove={handleProgressMouseMove}
        onMouseLeave={handleProgressMouseLeave}
      >
        {/* 背景轨道 */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 group-hover:h-2 bg-white/20 rounded-full transition-[height] duration-150" />
        {/* 已播放填充 + 圆点：rAF 驱动的小组件，避免 60Hz 大组件重渲染 */}
        <ProgressFill />
        <ProgressThumb hasMedia={hasMedia} />
        {hoverInfo && hasMedia && (
          <div
            className="absolute -top-8 -translate-x-1/2 px-2 py-0.5 rounded text-xs tabular-nums bg-black/90 border border-white/15 text-white whitespace-nowrap pointer-events-none shadow-lg"
            style={{ left: hoverInfo.x }}
          >
            {formatTime(hoverInfo.time)}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <IconBtn onClick={() => void playPrev()} label="上一首" disabled={!hasMedia}>
          <SkipBack size={18} />
        </IconBtn>
        <IconBtn onClick={() => void frameBackStep()} label="单帧后退 (Ctrl+←)" disabled={!hasMedia}>
          <ChevronFirst size={18} />
        </IconBtn>
        <PlayBtn playing={isPlaying} onClick={handlePlayPause} disabled={currentIndex < 0} />
        <IconBtn onClick={() => void frameStep()} label="单帧前进 (Ctrl+→)" disabled={!hasMedia}>
          <ChevronLast size={18} />
        </IconBtn>
        <IconBtn onClick={() => void playNext()} label="下一首" disabled={!hasMedia}>
          <SkipForward size={18} />
        </IconBtn>

        <div className="text-xs text-white/70 tabular-nums w-[120px] text-center ml-2">
          {formatTime(displayPos)} / {formatTime(duration)}
        </div>

        <div className="flex-1" />

        {/* Volume */}
        <div className="flex items-center gap-1">
          <IconBtn onClick={handleMuteToggle} label={muted ? "取消静音" : "静音"}>
            <VolumeIcon size={18} />
          </IconBtn>
          <div
            className="relative w-24 h-5 flex items-center cursor-pointer group"
            onMouseDown={handleVolume}
            title={`音量 ${muted ? 0 : displayVolume}%（Ctrl+点击恢复 80%）`}
          >
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 group-hover:h-2 bg-white/20 rounded-full transition-[height] duration-150" />
            {/*
              用 transform: scaleX 代替 width 来跟随拖动 —— 仅 GPU 合成，
              避免每帧布局回流；rounded 由 transformOrigin: left 保证。
              这样在 60Hz mousemove 下没有视觉跳动。
            */}
            <div
              className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 group-hover:h-2 bg-white/80 rounded-full transition-[height] duration-150 origin-left"
              style={{
                transform: `scaleX(${(muted ? 0 : displayVolume) / 100})`,
                willChange: "transform",
              }}
            />
            <div
              className="absolute top-1/2 w-3 h-3 group-hover:w-3.5 group-hover:h-3.5 rounded-full bg-white border-2 border-white/40 shadow transition-[width,height] duration-150 pointer-events-none"
              style={{
                left: `${muted ? 0 : displayVolume}%`,
                transform: "translate(-50%, -50%)",
              }}
            />
          </div>
          {/* 百分比数字 —— tabular-nums + 固定宽度,数字变化不抖动 */}
          <span className="ml-1 text-xs tabular-nums text-white/70 w-9 text-right select-none">
            {muted ? 0 : displayVolume}%
          </span>
        </div>

        {/* Speed */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setSpeedOpen((v) => !v)}
            className="inline-flex items-center gap-1 h-9 px-2.5 rounded-md text-sm text-white/85 hover:bg-white/10 hover:text-white tabular-nums"
            title="播放速度"
          >
            <Gauge size={16} />
            {speed}x
          </button>
          {speedOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSpeedOpen(false)} />
              <div className="absolute bottom-full right-0 mb-2 z-50 min-w-[110px] py-1 rounded-md border border-white/10 bg-neutral-900 shadow-xl text-sm text-white/90">
                {SPEED_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    className={`w-full px-3 py-1.5 text-left hover:bg-white/10 tabular-nums ${speed === opt ? "text-primary-300" : ""}`}
                    onClick={() => {
                      void setSpeedProp(opt);
                      setSpeedOpen(false);
                    }}
                  >
                    {speed === opt ? "✓ " : "  "}{opt}x
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <TrackMenu kind="audio" label="音轨" />
        <TrackMenu kind="sub" label="字幕" />

        <div className="w-px h-6 bg-white/10 mx-1" />

        <IconBtn
          onClick={() => setShowWaveform(!showWaveform)}
          label={showWaveform ? "隐藏底部波形条" : "显示底部波形条"}
          active={showWaveform}
        >
          <AudioWaveform size={18} />
        </IconBtn>
        <IconBtn
          onClick={togglePlaylist}
          label={playlistCollapsed ? "显示播放列表" : "隐藏播放列表"}
          active={!playlistCollapsed}
        >
          <ListMusic size={18} />
        </IconBtn>
        <IconBtn
          onClick={cyclePlaybackMode}
          label={
            playbackMode === "loop-playlist"
              ? "列表循环 (Ctrl+R 切换)"
              : playbackMode === "loop-single"
                ? "单曲循环 (Ctrl+R 切换)"
                : "随机播放 (Ctrl+R 切换)"
          }
          active={playbackMode !== "loop-playlist"}
        >
          {playbackMode === "loop-playlist" ? (
            <Repeat size={18} />
          ) : playbackMode === "loop-single" ? (
            <Repeat1 size={18} />
          ) : (
            <Shuffle size={18} />
          )}
        </IconBtn>
        <IconBtn
          onClick={toggleAlwaysOnTop}
          label={alwaysOnTop ? "取消窗口置顶 (Ctrl+T)" : "窗口置顶 (Ctrl+T)"}
          active={alwaysOnTop}
        >
          {alwaysOnTop ? <Pin size={18} /> : <PinOff size={18} />}
        </IconBtn>
        <IconBtn onClick={openSettings} label="设置">
          <Settings size={18} />
        </IconBtn>
        <IconBtn onClick={handleFullscreen} label={fullscreen ? "退出全屏" : "全屏"}>
          {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </IconBtn>
      </div>
    </div>
  );
}
