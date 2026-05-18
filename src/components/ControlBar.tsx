import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePlayerStore } from "../store/playerStore";
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

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function IconButton({ onPress, label, children, isDisabled }: {
  onPress: () => void;
  label: string;
  children: React.ReactNode;
  isDisabled?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      isIconOnly
      onPress={onPress}
      aria-label={label}
      isDisabled={isDisabled}
    >
      {children}
    </Button>
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
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);

  const [dragValue, setDragValue] = useState<number | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; time: number } | null>(null);
  const [speedOpen, setSpeedOpen] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);
  const lastVolRef = useRef(volume);

  useEffect(() => {
    if (volume > 0) lastVolRef.current = volume;
  }, [volume]);

  const hasMedia = currentIndex >= 0 && duration > 0;
  const displayPos = dragValue ?? position;
  const progress = hasMedia ? Math.min(1, Math.max(0, displayPos / duration)) : 0;

  const handlePlayPause = () => {
    if (currentIndex < 0) return;
    void togglePause(isPlaying);
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

  const volumeIcon = muted || volume === 0 ? "🔇" : volume < 33 ? "🔈" : volume < 66 ? "🔉" : "🔊";

  return (
    <div
      className="flex flex-col gap-1 px-4 py-2 bg-black/60 backdrop-blur-md border-t border-white/10"
      style={{ zIndex: 20, position: "relative" }}
    >
      {/* Progress bar */}
      <div
        ref={progressRef}
        className="relative h-2 group cursor-pointer"
        onMouseDown={handleProgressDown}
        onMouseMove={handleProgressMouseMove}
        onMouseLeave={handleProgressMouseLeave}
      >
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-white/15 rounded-full" />
        <div
          className="absolute top-1/2 -translate-y-1/2 left-0 h-1 bg-primary-500 rounded-full"
          style={{ width: `${progress * 100}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ left: `${progress * 100}%` }}
        />
        {hoverInfo && hasMedia && (
          <div
            className="absolute -top-7 -translate-x-1/2 px-1.5 py-0.5 rounded text-[10px] bg-black/80 text-white whitespace-nowrap pointer-events-none"
            style={{ left: hoverInfo.x }}
          >
            {formatTime(hoverInfo.time)}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <IconButton onPress={() => void playPrev()} label="上一首" isDisabled={!hasMedia}>
          ⏮
        </IconButton>
        <IconButton onPress={() => void frameBackStep()} label="单帧后退" isDisabled={!hasMedia}>
          ⏪
        </IconButton>
        <IconButton onPress={handlePlayPause} label={isPlaying ? "暂停" : "播放"} isDisabled={currentIndex < 0}>
          {isPlaying ? "⏸" : "▶"}
        </IconButton>
        <IconButton onPress={() => void frameStep()} label="单帧前进" isDisabled={!hasMedia}>
          ⏩
        </IconButton>
        <IconButton onPress={() => void playNext()} label="下一首" isDisabled={!hasMedia}>
          ⏭
        </IconButton>

        <div className="text-xs text-white/70 tabular-nums w-[110px] text-center">
          {formatTime(displayPos)} / {formatTime(duration)}
        </div>

        <div className="flex-1" />

        {/* Volume */}
        <div className="flex items-center gap-1">
          <button
            className="text-lg w-7 h-7 hover:bg-white/10 rounded flex items-center justify-center"
            onClick={handleMuteToggle}
            aria-label="静音"
          >
            {volumeIcon}
          </button>
          <div
            className="relative w-24 h-2 cursor-pointer group"
            onMouseDown={handleVolume}
          >
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-white/15 rounded-full" />
            <div
              className="absolute top-1/2 -translate-y-1/2 left-0 h-1 bg-white/70 rounded-full"
              style={{ width: `${muted ? 0 : volume}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-white opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ left: `${muted ? 0 : volume}%` }}
            />
          </div>
        </div>

        {/* Speed */}
        <div className="relative">
          <Button size="sm" variant="outline" onPress={() => setSpeedOpen((v) => !v)}>
            {speed}x
          </Button>
          {speedOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSpeedOpen(false)} />
              <div className="absolute bottom-full right-0 mb-2 z-50 min-w-[100px] py-1 rounded-md border border-white/10 bg-neutral-900/95 backdrop-blur-md shadow-xl text-sm text-white/90">
                {SPEED_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    className={`w-full px-3 py-1.5 text-left hover:bg-white/10 ${speed === opt ? "text-primary-300" : ""}`}
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

        <IconButton onPress={handleFullscreen} label="全屏">
          ⛶
        </IconButton>
      </div>
    </div>
  );
}
