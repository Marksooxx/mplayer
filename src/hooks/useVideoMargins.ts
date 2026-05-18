import { useEffect } from "react";
import { setVideoMarginRatio } from "tauri-plugin-libmpv-api";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";

// 桌面应用的固定尺寸常量（与 PlaylistPanel / ControlBar / WaveformStrip 内的硬编码保持一致）
const PLAYLIST_WIDTH = 280;
const CONTROL_BAR_HEIGHT = 60; // ControlBar 实际渲染高度约 60px
const WAVEFORM_HEIGHT = 56;

/**
 * 把 UI（右侧播放列表 + 底部控件）所占空间换算为 mpv 的 video-margin-ratio，
 * 让 mpv 视频画面只在 UI 之外的区域渲染。
 *
 * 改为**状态驱动**而非 DOM 测量（ResizeObserver）：
 * - 切换 playlistCollapsed / showWaveform / fullscreen 时立即用预设尺寸算 margin
 *   一次性同步发到 mpv，避免"DOM 渲染 → 测量 → 通知 mpv"的多步异步延迟，
 *   不再有 mpv 短暂覆盖 playlist 区域的视觉 bug。
 * - 仅在 window resize 时重新计算（这种情况下整窗变化是合理的）。
 */
export function useVideoMargins(): void {
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const playlistCollapsed = useSettingsStore((s) => s.playlistCollapsed);
  const showWaveform = useSettingsStore((s) => s.showWaveform);

  useEffect(() => {
    const apply = () => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      const sideW = !fullscreen && !playlistCollapsed ? PLAYLIST_WIDTH : 0;
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
  }, [fullscreen, playlistCollapsed, showWaveform]);
}
