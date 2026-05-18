import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TopBar } from "./components/TopBar";
import { PlayerView } from "./components/PlayerView";
import { ControlBar } from "./components/ControlBar";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { SettingsPanel } from "./components/SettingsPanel";
import { WaveformStrip } from "./components/WaveformStrip";
import { GotoFrameDialog } from "./components/GotoFrameDialog";
import { useMpv } from "./hooks/useMpv";
import { useVideoMargins } from "./hooks/useVideoMargins";
import { useLaunchFiles } from "./hooks/useLaunchFiles";
import { usePlayerStore } from "./store/playerStore";
import { useSettingsStore } from "./store/settingsStore";

function FullscreenAutoHide({ children }: { children: React.ReactNode }) {
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const setControlsVisible = usePlayerStore((s) => s.setControlsVisible);
  const controlsVisible = usePlayerStore((s) => s.controlsVisible);

  useEffect(() => {
    if (!fullscreen) {
      setControlsVisible(true);
      document.body.classList.remove("cursor-hidden");
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reset = () => {
      setControlsVisible(true);
      document.body.classList.remove("cursor-hidden");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setControlsVisible(false);
        document.body.classList.add("cursor-hidden");
      }, 3000);
    };
    reset();
    window.addEventListener("mousemove", reset);
    window.addEventListener("keydown", reset);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("mousemove", reset);
      window.removeEventListener("keydown", reset);
      document.body.classList.remove("cursor-hidden");
    };
  }, [fullscreen, setControlsVisible]);

  return (
    <div
      style={{
        transition: "opacity 200ms ease",
        opacity: fullscreen && !controlsVisible ? 0 : 1,
        pointerEvents: fullscreen && !controlsVisible ? "none" : "auto",
      }}
    >
      {children}
    </div>
  );
}

function DragHoverOverlay() {
  const dragHover = usePlayerStore((s) => s.dragHover);
  if (!dragHover) return null;
  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-primary-500/15 backdrop-blur-[1px] border-4 border-dashed border-primary-300 animate-[fadeIn_120ms_ease] pointer-events-none"
      aria-hidden
    >
      <div className="flex flex-col items-center gap-3 px-8 py-6 rounded-2xl bg-neutral-900/90 border border-primary-400 shadow-2xl">
        <Download size={48} className="text-primary-300" strokeWidth={1.5} />
        <div className="text-lg font-medium text-white">放手即添加到播放列表</div>
        <div className="text-xs text-white/50">支持 mp4 / mkv / mp3 等几乎所有格式</div>
      </div>
    </div>
  );
}

function ErrorToast() {
  const errorMsg = usePlayerStore((s) => s.errorMsg);
  const setError = usePlayerStore((s) => s.setError);

  if (!errorMsg) return null;
  return (
    <div
      className="absolute top-16 left-1/2 -translate-x-1/2 flex items-start gap-2 max-w-[80%] px-4 py-2 rounded-md bg-red-600 text-white text-sm shadow-2xl border border-red-400 anim-slide-down"
      style={{ zIndex: 100 }}
    >
      <span className="break-words">{errorMsg}</span>
      <button
        type="button"
        onClick={() => setError(null)}
        className="shrink-0 ml-2 text-white/80 hover:text-white"
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  );
}

function App() {
  useMpv();
  useVideoMargins();
  useLaunchFiles();

  // 首帧渲染后再让 Tauri 显示窗口，避免冷启动期间的白底闪烁。
  // tauri.conf.json 已设 visible: false。
  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        void getCurrentWindow().show();
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const playlistCollapsed = useSettingsStore((s) => s.playlistCollapsed);
  const showWaveform = useSettingsStore((s) => s.showWaveform);

  // 桌面 UX：playlist 关→开时，mpv 的 video-margin IPC 需要 ~30-80ms 才能让出
  // 那 280px 区域。如果立刻 mount PlaylistPanel，mpv 子窗口（绘制在 webview 上）
  // 会短暂盖住 playlist 文字。先等 mpv 退让再渲染。
  const [renderPlaylist, setRenderPlaylist] = useState(!playlistCollapsed);
  useEffect(() => {
    if (playlistCollapsed) {
      setRenderPlaylist(false); // 关闭：立即移除
      return;
    }
    // 打开：让 useVideoMargins 先发出 IPC，再 mount
    const t = setTimeout(() => setRenderPlaylist(true), 80);
    return () => clearTimeout(t);
  }, [playlistCollapsed]);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .onResized(async () => {
        const cur = await win.isFullscreen();
        setFullscreen(cur);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [setFullscreen]);

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden" style={{ background: "transparent" }}>
      <KeyboardShortcuts />

      <div className="flex-1 flex min-h-0 relative">
        <main className="flex-1 relative min-w-0" style={{ background: "transparent" }}>
          <PlayerView />
          <ErrorToast />
          <TopBar />
        </main>
        {!fullscreen && renderPlaylist && <PlaylistPanel />}
      </div>

      <FullscreenAutoHide>
        <div style={{ display: fullscreen ? "none" : "block" }}>
          {showWaveform && <WaveformStrip height={56} />}
          <ControlBar />
        </div>
      </FullscreenAutoHide>

      <SettingsPanel />
      <GotoFrameDialog />
      <DragHoverOverlay />
    </div>
  );
}

export default App;
