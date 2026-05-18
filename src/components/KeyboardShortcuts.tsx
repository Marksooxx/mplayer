import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePlayerStore } from "../store/playerStore";
import {
  frameBackStep,
  frameStep,
  seekRelative,
  setMutedProp,
  setVolumeProp,
  togglePause,
} from "../lib/mpv";

function shouldIgnore(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    target.isContentEditable
  );
}

export function KeyboardShortcuts() {
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnore(e.target)) return;

      const state = usePlayerStore.getState();
      const hasMedia = state.currentIndex >= 0;

      switch (e.key) {
        case " ": {
          e.preventDefault();
          if (hasMedia) void togglePause(state.isPlaying);
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (!hasMedia) break;
          if (e.ctrlKey) void frameBackStep();
          else void seekRelative(-5);
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          if (!hasMedia) break;
          if (e.ctrlKey) void frameStep();
          else void seekRelative(5);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          void setVolumeProp(Math.min(100, state.volume + 5));
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          void setVolumeProp(Math.max(0, state.volume - 5));
          break;
        }
        case "f":
        case "F": {
          e.preventDefault();
          void (async () => {
            const win = getCurrentWindow();
            const cur = await win.isFullscreen();
            await win.setFullscreen(!cur);
            setFullscreen(!cur);
          })();
          break;
        }
        case "Escape": {
          void (async () => {
            const win = getCurrentWindow();
            const cur = await win.isFullscreen();
            if (cur) {
              await win.setFullscreen(false);
              setFullscreen(false);
            }
          })();
          break;
        }
        case "m":
        case "M": {
          e.preventDefault();
          void setMutedProp(!state.muted);
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setFullscreen]);

  return null;
}
