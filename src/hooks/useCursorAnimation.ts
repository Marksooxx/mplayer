import { useEffect, type RefObject } from "react";
import { usePlayerStore } from "../store/playerStore";

/**
 * 进度光标的 rAF 插值动画（社区主流播放器做法）。
 *
 * 核心：`mpv` 报的 `time-pos` 是离散事件 + IPC 延迟，永远比真实播放位置慢
 * ~10-20ms。如果暂停那帧直接切到"mpv 真实位置"，cursor 就会向前飘一小段
 * （raw 位置比之前插值的位置往前一截）。
 *
 * 正确做法：**暂停帧冻结在上一帧插值算出来的位置**，轨迹完全连续，零瞬移：
 *
 *   播放：pos = position + (now - observedAt) × speed
 *         lastExtrapolated = pos
 *   暂停：pos = lastExtrapolated   ← 不切换到 raw position
 *   拖动：pos = dragPosition       ← snap 到鼠标
 *
 * 实施：每个 cursor 元素一个独立 rAF 循环，用 ref 直接操作 style，零 React 重渲染。
 */
export function useCursorAnimation(
  ref: RefObject<HTMLElement | null>,
  updater: (el: HTMLElement, progress: number) => void,
): void {
  useEffect(() => {
    let raf = 0;
    // 上一帧插值算出来的位置；暂停时用它冻结，避免跳变到 raw 位置
    let lastExtrapolated = 0;
    let initialized = false;

    const tick = () => {
      const s = usePlayerStore.getState();
      let pos: number;

      if (s.dragPosition !== null) {
        // 拖动：snap 到鼠标
        pos = s.dragPosition;
        lastExtrapolated = pos;
        initialized = true;
      } else if (s.isPlaying && s.positionObservedAt > 0) {
        // 播放：用 rAF 插值
        const elapsed = (performance.now() - s.positionObservedAt) / 1000;
        pos = s.position + elapsed * s.speed;
        if (s.duration > 0 && pos > s.duration) pos = s.duration;
        if (pos < 0) pos = 0;
        lastExtrapolated = pos;
        initialized = true;
      } else {
        // 暂停 / 未就绪：冻结于上一帧插值值；首次（还没插过）退回 raw
        pos = initialized ? lastExtrapolated : s.position;
      }

      const progress =
        s.duration > 0 ? Math.max(0, Math.min(1, pos / s.duration)) : 0;

      const el = ref.current;
      if (el) updater(el, progress);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ref, updater]);
}
