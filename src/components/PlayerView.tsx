import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePlayerStore } from "../store/playerStore";
import {
  togglePause,
  setVolumeProp,
} from "../lib/mpv";
import { playIndex } from "../hooks/useMpv";

const SINGLE_CLICK_DELAY = 250;

export function PlayerView() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const volume = usePlayerStore((s) => s.volume);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const appendToPlaylist = usePlayerStore((s) => s.appendToPlaylist);

  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = () => {
    if (currentIndex < 0) return;
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      return;
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      void togglePause(isPlaying);
    }, SINGLE_CLICK_DELAY);
  };

  const handleDoubleClick = async () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    const win = getCurrentWindow();
    const current = await win.isFullscreen();
    await win.setFullscreen(!current);
    setFullscreen(!current);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -2 : 2;
    const next = Math.max(0, Math.min(100, volume + delta));
    void setVolumeProp(next);
  };

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const paths = event.payload.paths;
          if (paths.length === 0) return;
          const startEmpty = playlist.length === 0;
          const added = appendToPlaylist(paths);
          if (startEmpty && added.length > 0) {
            void playIndex(0);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [playlist.length, appendToPlaylist]);

  return (
    <div
      className="relative h-full w-full"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        background: "transparent",
        cursor: currentIndex >= 0 ? "pointer" : "default",
      }}
    >
      {currentIndex < 0 && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none"
          style={{ zIndex: 5 }}
        >
          <div className="text-white/60 text-2xl font-light">mplayer</div>
          <div className="text-white/40 text-sm">把文件拖到这里，或点击顶部「打开文件」</div>
        </div>
      )}
    </div>
  );
}
