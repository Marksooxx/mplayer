import { useEffect } from "react";
import { setVideoMarginRatio } from "tauri-plugin-libmpv-api";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";

// 仅 ControlBar / WaveformStrip 是固定常量；播放列表宽度可由用户拖动 left handle 调整，
// 通过 settingsStore.playlistWidth 动态获取
const CONTROL_BAR_HEIGHT = 60; // ControlBar 实际渲染高度约 60px
const WAVEFORM_HEIGHT = 56;

/**
 * 把 UI（右侧播放列表 + 底部控件）所占空间换算为 mpv 的 video-margin-ratio，
 * 让 mpv 视频画面只在 UI 之外的区域渲染。
 *
 * 状态驱动（不依赖 DOM 测量）：playlistCollapsed / playlistWidth / showWaveform /
 * fullscreen 任一变化都立刻同步算出 margin 发到 mpv，无可见延迟。
 */
export function useVideoMargins(): void {
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const playlistCollapsed = useSettingsStore((s) => s.playlistCollapsed);
  const showWaveform = useSettingsStore((s) => s.showWaveform);
  const playlistWidth = useSettingsStore((s) => s.playlistWidth);

  useEffect(() => {
    const apply = () => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      const sideW = !fullscreen && !playlistCollapsed ? playlistWidth : 0;
      const bottomH = !fullscreen
        ? CONTROL_BAR_HEIGHT + (showWaveform ? WAVEFORM_HEIGHT : 0)
        : 0;
      const ratio = {
        top: 0,
        bottom: Math.max(0, Math.min(0.5, bottomH / h)),
        right: Math.max(0, Math.min(0.5, sideW / w)),
        left: 0,
      };
      void setVideoMarginRatio(ratio).catch(() => {
        /* mpv may not be ready yet */
      });
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [fullscreen, playlistCollapsed, showWaveform, playlistWidth]);
}
