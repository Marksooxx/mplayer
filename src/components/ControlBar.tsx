import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronFirst,
  ChevronLast,
  Gauge,
  ListMusic,
  Maximize,
  Minimize,
  Pause,
  Play,
  Settings,
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
  setPaused,
  setSpeedProp,
  setVolumeProp,
} from "../lib/mpv";
import { playNext, playPrev } from "../hooks/useMpv";
import { formatTime } from "../lib/format";
import { TrackMenu } from "./TrackMenu";

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

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

  const [dragValue, setDragValue] = useState<number | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; time: number } | null>(null);
  const [speedOpen, setSpeedOpen] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);
  const lastVolRef = useRef(volume);

  useEffect(() => {
    if (volume > 0 && !muted) lastVolRef.current = volume;
  }, [volume, muted]);

  const hasMedia = currentIndex >= 0 && duration > 0;
  const displayPos = dragValue ?? position;
  const progress = hasMedia ? Math.min(1, Math.max(0, displayPos / duration)) : 0;

  const handlePlayPause = () => {
    if (currentIndex < 0) return;
    void setPaused(isPlaying);
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
      setDragValue(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleVolume = (e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLDivElement;
    const rect = el.getBoundingClientRect();
    const setFromX = (x: number) => {
      const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      const v = Math.round(ratio * 100);
      void setVolumeProp(v);
      if (muted && v > 0) void setMutedProp(false);
    };
    setFromX(e.clientX);
    const onMove = (ev: MouseEvent) => setFromX(ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
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

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 33 ? Volume : volume < 66 ? Volume1 : Volume2;

  return (
    <div
      className="flex flex-col gap-1 px-4 py-2 bg-neutral-950 border-t border-white/10 select-none"
      style={{ zIndex: 20, position: "relative" }}
    >
      {/* Progress bar — HeroUI Slider 视觉风格：轨道常驻、主色填充、圆点常驻 hover 放大 */}
      <div
        ref={progressRef}
        className="relative h-5 group cursor-pointer flex items-center"
        onMouseDown={handleProgressDown}
        onMouseMove={handleProgressMouseMove}
        onMouseLeave={handleProgressMouseLeave}
      >
        {/* 背景轨道 */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 group-hover:h-2 bg-white/20 rounded-full transition-all duration-150" />
        {/* 已播放填充 */}
        <div
          className="absolute top-1/2 -translate-y-1/2 left-0 h-1.5 group-hover:h-2 bg-primary-500 rounded-full transition-all duration-150"
          style={{ width: `${progress * 100}%` }}
        />
        {/* 圆点 */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 group-hover:w-4 group-hover:h-4 rounded-full bg-white border-2 border-primary-500 shadow-md transition-all duration-150"
          style={{ left: `${progress * 100}%`, opacity: hasMedia ? 1 : 0 }}
        />
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
            title={`音量 ${muted ? 0 : volume}`}
          >
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 group-hover:h-2 bg-white/20 rounded-full transition-all duration-150" />
            <div
              className="absolute top-1/2 -translate-y-1/2 left-0 h-1.5 group-hover:h-2 bg-white/80 rounded-full transition-all duration-150"
              style={{ width: `${muted ? 0 : volume}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 group-hover:w-3.5 group-hover:h-3.5 rounded-full bg-white border-2 border-white/40 shadow transition-all duration-150"
              style={{ left: `${muted ? 0 : volume}%` }}
            />
          </div>
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
          onClick={togglePlaylist}
          label={playlistCollapsed ? "显示播放列表" : "隐藏播放列表"}
          active={!playlistCollapsed}
        >
          <ListMusic size={18} />
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
