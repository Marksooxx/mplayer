import { useEffect } from "react";
import { setVideoMarginRatio } from "tauri-plugin-libmpv-api";
import { usePlayerStore } from "../store/playerStore";

/**
 * 把 UI（右侧播放列表 + 底部控件）所占空间换算为 mpv 的 video-margin-ratio，
 * 让 mpv 视频画面只在 UI 之外的区域渲染。
 * 顶栏是浮层不影响视频；故不计入 top margin。
 */
export function useVideoMargins(
  sideRef: React.RefObject<HTMLElement | null>,
  bottomRef: React.RefObject<HTMLElement | null>,
) {
  const fullscreen = usePlayerStore((s) => s.fullscreen);

  useEffect(() => {
    let raf = 0;

    const compute = () => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      const bottomH = !fullscreen && bottomRef.current ? bottomRef.current.offsetHeight : 0;
      const sideW = !fullscreen && sideRef.current ? sideRef.current.offsetWidth : 0;
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

    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    };

    schedule();
    window.addEventListener("resize", schedule);

    const ro = new ResizeObserver(schedule);
    if (sideRef.current) ro.observe(sideRef.current);
    if (bottomRef.current) ro.observe(bottomRef.current);

    return () => {
      window.removeEventListener("resize", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [fullscreen, sideRef, bottomRef]);
}
