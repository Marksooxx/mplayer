import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TopBar } from "./components/TopBar";
import { PlayerView } from "./components/PlayerView";
import { ControlBar } from "./components/ControlBar";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { SettingsPanel } from "./components/SettingsPanel";
import { useMpv } from "./hooks/useMpv";
import { useVideoMargins } from "./hooks/useVideoMargins";
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

function ErrorToast() {
  const errorMsg = usePlayerStore((s) => s.errorMsg);
  const setError = usePlayerStore((s) => s.setError);

  if (!errorMsg) return null;
  return (
    <div
      className="absolute top-16 left-1/2 -translate-x-1/2 flex items-start gap-2 max-w-[80%] px-4 py-2 rounded-md bg-red-600 text-white text-sm shadow-2xl border border-red-400"
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

  const sideRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const playlistCollapsed = useSettingsStore((s) => s.playlistCollapsed);

  useVideoMargins(sideRef, bottomRef);

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
        {!fullscreen && !playlistCollapsed && (
          <div ref={sideRef}>
            <PlaylistPanel />
          </div>
        )}
      </div>

      <FullscreenAutoHide>
        <div ref={bottomRef} style={{ display: fullscreen ? "none" : "block" }}>
          <ControlBar />
        </div>
      </FullscreenAutoHide>

      <SettingsPanel />
    </div>
  );
}

export default App;
