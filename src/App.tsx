import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TopBar } from "./components/TopBar";
import { PlayerView } from "./components/PlayerView";
import { ControlBar } from "./components/ControlBar";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { useMpv } from "./hooks/useMpv";
import { useVideoMargins } from "./hooks/useVideoMargins";
import { usePlayerStore } from "./store/playerStore";

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

  useEffect(() => {
    if (!errorMsg) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [errorMsg, setError]);

  if (!errorMsg) return null;
  return (
    <div
      className="absolute top-14 left-1/2 -translate-x-1/2 px-4 py-2 rounded-md bg-red-500/90 text-white text-sm shadow-lg"
      style={{ zIndex: 100 }}
    >
      {errorMsg}
    </div>
  );
}

function App() {
  useMpv();

  const topRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);

  useVideoMargins(topRef, sideRef, bottomRef);

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
    <div className="w-screen h-screen flex flex-col" style={{ background: "transparent" }}>
      <KeyboardShortcuts />

      <FullscreenAutoHide>
        <div ref={topRef} style={{ display: fullscreen ? "none" : "block" }}>
          <TopBar />
        </div>
      </FullscreenAutoHide>

      <div className="flex-1 flex min-h-0 relative">
        <main className="flex-1 relative min-w-0" style={{ background: "transparent" }}>
          <PlayerView />
          <ErrorToast />
        </main>
        {!fullscreen && (
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
    </div>
  );
}

export default App;
