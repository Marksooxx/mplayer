import { useEffect } from "react";
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
import { useGracefulShutdown } from "./hooks/useGracefulShutdown";
import { useAlwaysOnTop } from "./hooks/useAlwaysOnTop";
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
  useGracefulShutdown();
  useAlwaysOnTop();

  // 启动序列（防白闪 + 防透明窗）：
  //   1. tauri.conf.json visible: false → 窗口创建后不可见
  //   2. index.html 静态 #boot-bg 黑底盖住一切（z-index: 9999）
  //   3. React 完成首帧绘制（PlayerView idle overlay 已上屏）后：
  //      → window.show() 显示窗口 → 用户看到 #boot-bg 黑色
  //      → 再下一帧移除 #boot-bg → 露出 PlayerView idle overlay（同色黑底）
  //   过渡完全无感：黑 → 黑 → 黑。
  //   Rust setup 1.5s failsafe 兜底 show()，即使前端阻塞，用户也只看到黑底。
  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        getCurrentWindow()
          .show()
          .catch((err) => console.error("[startup] window.show failed", err));
        // 再推一帧，确保 PlayerView 已经 paint，再撤掉占位
        requestAnimationFrame(() => {
          document.getElementById("boot-bg")?.remove();
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const showWaveform = useSettingsStore((s) => s.showWaveform);
  const playlistCollapsed = useSettingsStore((s) => s.playlistCollapsed);
  const playlistWidth = useSettingsStore((s) => s.playlistWidth);

  // 注：PlaylistPanel 是"absolute right-0 + transform translateX 滑入滑出",
  // 不占 flex 布局空间(详见 PlaylistPanel.tsx)。为了让 main 区域不蔓延到
  // playlist 应有的位置(导致 TopBar 横跨整窗 + PlayerView 视频区被压在
  // panel 后面),用一个 flex spacer 占据 playlist 的物理空间——main flex-1
  // 自动缩到视频区宽度。
  //
  // spacer 自身透明(没有任何不透明 DOM):
  //   - !collapsed: width = playlistWidth, panel transform: translateX(0) 在 spacer 上
  //   - collapsed: width = 0, panel transform: translateX(width) 滑出屏外, main 扩展全宽
  // spacer width transition 跟 panel transform transition 同步(同 220ms + 同
  // easing),保证 main / panel / mpv-margin 三者视觉同步收缩/扩展。
  // 漏光防御:mpv 的 background-color=#000000 + background=color 在 margin
  // 区域填黑色,即使 spacer 透明,mpv 自己负责非视频区填充——不会穿透到桌面。

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
        {/* spacer：占据 PlaylistPanel 应有的 flex 空间，让 main 收缩到视频区。
            width 跟随 playlistCollapsed，跟 PlaylistPanel transform 同步 transition。 */}
        {!fullscreen && (
          <div
            aria-hidden
            className="shrink-0"
            style={{
              width: playlistCollapsed ? 0 : playlistWidth,
              transition: "width 220ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          />
        )}
        {/* PlaylistPanel 自带 absolute 定位 + transform 控制可见，不占 flex 布局 */}
        {!fullscreen && <PlaylistPanel />}
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
