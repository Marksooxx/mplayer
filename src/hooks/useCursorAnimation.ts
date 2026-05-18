import { useEffect, type RefObject } from "react";
import { usePlayerStore } from "../store/playerStore";

/**
 * 进度光标的 rAF 插值动画。
 *
 * 设计思路（参考 YouTube / VLC web / wavesurfer 等）：
 *   - mpv 的 `time-pos` 是离散事件（每视频帧 16-42ms 一次，且经 Tauri IPC 后会有 jitter）。
 *   - 直接渲染会看到"步进式"跳动；CSS transition 把跳动涂均匀但永远滞后 100ms。
 *   - 正确做法是 rAF 插值：每屏幕刷新一次，用"上次观测位置 + 已逝时间 × 速度"估算
 *     此刻 mpv 的实际位置，与屏幕同频更新光标。
 *
 * 实现要点：
 *   - 不走 React state；直接通过 ref 操作 `style.transform / style.left`，零额外渲染。
 *   - 拖动期间不插值（用 dragPosition）。
 *   - 暂停期间不插值（mpv 真实静止，用 store.position）；同时启用短 transition
 *     吸收"暂停瞬间最后一帧插值值"与"mpv 最终汇报位置"之间的微小差异。
 *
 * @param ref          目标 DOM 元素
 * @param updater      回调，给定 progress (0..1)，由调用方决定写到 left:% 还是 scaleX
 * @param baseTransition  非播放态的 transition 字符串（含 left/transform 之外的 width/height/opacity）
 */
export function useCursorAnimation(
  ref: RefObject<HTMLElement | null>,
  updater: (el: HTMLElement, progress: number) => void,
  baseTransition: string,
  smoothProperty: "left" | "transform",
): void {
  useEffect(() => {
    let raf = 0;
    let lastTransitionWasSmooth: boolean | null = null;

    const tick = () => {
      const s = usePlayerStore.getState();
      let pos: number;
      let smooth = false;

      if (s.dragPosition !== null) {
        // 拖动：snap 到鼠标
        pos = s.dragPosition;
      } else if (s.isPlaying && s.positionObservedAt > 0) {
        // 播放：用 rAF 插值 = 上次观测位置 + 已逝时间 × 速度
        const elapsed = (performance.now() - s.positionObservedAt) / 1000;
        pos = s.position + elapsed * s.speed;
        if (s.duration > 0 && pos > s.duration) pos = s.duration;
      } else {
        // 暂停 / 未就绪：用真实位置；并启用 transition 吸收最后那一小段差异
        pos = s.position;
        smooth = true;
      }

      const progress =
        s.duration > 0 ? Math.max(0, Math.min(1, pos / s.duration)) : 0;

      const el = ref.current;
      if (el) {
        // 仅在 smooth 状态切换时修改 transition，避免每帧都写 style.transition
        if (smooth !== lastTransitionWasSmooth) {
          el.style.transition = smooth
            ? `${smoothProperty} 120ms linear, ${baseTransition}`
            : baseTransition;
          lastTransitionWasSmooth = smooth;
        }
        updater(el, progress);
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ref, updater, baseTransition, smoothProperty]);
}
