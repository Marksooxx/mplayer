import { useEffect, useRef } from "react";
import { Film, Loader2, Music4 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePlayerStore } from "../store/playerStore";
import { addSubtitle, setVolumeProp, togglePause } from "../lib/mpv";
import { playIndex } from "../hooks/useMpv";

const SUBTITLE_EXTS = new Set([
  "srt", "ass", "ssa", "sub", "vtt", "idx", "smi", "sup",
]);

function classifyDrops(paths: string[]): { subs: string[]; media: string[] } {
  const subs: string[] = [];
  const media: string[] = [];
  for (const p of paths) {
    const ext = p.split(/[.]/).pop()?.toLowerCase() ?? "";
    if (SUBTITLE_EXTS.has(ext)) subs.push(p);
    else media.push(p);
  }
  return { subs, media };
}

const SINGLE_CLICK_DELAY = 250;

export function PlayerView() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const fileLoaded = usePlayerStore((s) => s.fileLoaded);
  const videoWidth = usePlayerStore((s) => s.videoWidth);
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
      void togglePause();
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
    const setDragHover = usePlayerStore.getState().setDragHover;
    let unlisten: (() => void) | undefined;
    void win
      .onDragDropEvent((event) => {
        switch (event.payload.type) {
          case "enter":
          case "over":
            setDragHover(true);
            break;
          case "leave":
            setDragHover(false);
            break;
          case "drop": {
            setDragHover(false);
            const paths = event.payload.paths;
            if (paths.length === 0) return;
            // 字幕 vs 媒体 分类:字幕走 mpv sub-add(需要已有当前播放视频),
            // 其他走 playlist 入列
            const { subs, media } = classifyDrops(paths);
            const state = usePlayerStore.getState();
            if (subs.length > 0 && state.currentIndex >= 0) {
              for (const sub of subs) {
                void addSubtitle(sub).catch((err) =>
                  console.error("[drop] sub-add failed", err),
                );
              }
            }
            if (media.length > 0) {
              const startEmpty = playlist.length === 0;
              const added = appendToPlaylist(media);
              if (startEmpty && added.length > 0) {
                void playIndex(0);
              }
            }
            break;
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

  const isIdle = currentIndex < 0;
  const isLoading = !isIdle && !fileLoaded;
  const isAudioOnly = fileLoaded && videoWidth <= 0;
  const showOverlay = isIdle || isLoading || isAudioOnly;
  const current = currentIndex >= 0 ? playlist[currentIndex] : null;

  return (
    <div
      className="relative h-full w-full"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        background: "transparent",
        cursor: currentIndex >= 0 && !isAudioOnly ? "pointer" : "default",
      }}
    >
      {showOverlay && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950 pointer-events-none"
          style={{ zIndex: 5 }}
        >
          {isIdle && (
            <>
              <Film size={48} className="text-white/30" strokeWidth={1.5} />
              <div className="text-white/70 text-xl font-light tracking-wide">mplayer</div>
              <div className="text-white/40 text-sm">把文件拖到这里，或点击顶部「打开文件」</div>
            </>
          )}
          {isLoading && (
            <>
              <Loader2 size={36} className="text-white/60 animate-spin" />
              <div className="text-white/50 text-sm">加载中...</div>
            </>
          )}
          {isAudioOnly && !isLoading && (
            <>
              <div className="relative">
                <Music4 size={72} className="text-primary-400/80" strokeWidth={1.5} />
                {isPlaying && (
                  <span className="absolute -bottom-1 -right-1 inline-flex h-3 w-3 rounded-full bg-primary-500 animate-pulse" />
                )}
              </div>
              <div className="text-white/85 text-base font-medium max-w-[80%] text-center truncate px-4">
                {current?.name ?? "音频"}
              </div>
              <div className="text-white/40 text-xs">音频播放中 — 波形见底部</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
