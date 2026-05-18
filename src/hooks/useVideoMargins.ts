import { useEffect } from "react";
import { setVideoMarginRatio } from "tauri-plugin-libmpv-api";
import { usePlayerStore } from "../store/playerStore";

export function useVideoMargins(
  topRef: React.RefObject<HTMLElement | null>,
  sideRef: React.RefObject<HTMLElement | null>,
  bottomRef: React.RefObject<HTMLElement | null>,
) {
  const fullscreen = usePlayerStore((s) => s.fullscreen);

  useEffect(() => {
    let raf = 0;

    const compute = () => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      const topH = !fullscreen && topRef.current ? topRef.current.offsetHeight : 0;
      const bottomH = !fullscreen && bottomRef.current ? bottomRef.current.offsetHeight : 0;
      const sideW = !fullscreen && sideRef.current ? sideRef.current.offsetWidth : 0;
      const ratio = {
        top: Math.max(0, Math.min(0.5, topH / h)),
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
    if (topRef.current) ro.observe(topRef.current);
    if (sideRef.current) ro.observe(sideRef.current);
    if (bottomRef.current) ro.observe(bottomRef.current);

    return () => {
      window.removeEventListener("resize", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [fullscreen, topRef, sideRef, bottomRef]);
}
