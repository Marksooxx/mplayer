import { useEffect, type RefObject } from "react";
import { usePlayerStore } from "../store/playerStore";

/**
 * 进度光标的虚拟播放头（virtual playhead）。
 *
 * ★ 为什么不再读 mpv 的 time-pos ★
 *
 * mpv 在 30fps 视频下每 ~33ms 发一次 `time-pos` 事件，且经 Tauri IPC 后有
 * ~10-20ms 延迟。如果每次事件都"snap"插值参考点：
 *   - 新 `position` 比我们之前外推的位置领先 IPC 延迟那么一截
 *   - 这种 forward snap 在播放中被持续运动掩盖看不出
 *   - 但**暂停瞬间**：mpv 先发"最终 time-pos"、再发 pause；我们冻结的
 *     `lastExtrapolated` 刚被最后那次 snap 推到前面，于是 cursor 就向前
 *     瞬移一小段，肉眼可见，尤其在 144Hz 屏上
 *
 * ★ 改成虚拟播放头 ★
 *
 * 每帧 `displayed += dt × speed`，完全无视 mpv 报的小幅 position 变化；
 * 只在差距 > 0.3 秒时认为是真正的 seek 才 snap。pause 不再读 raw position，
 * dt 累加自然停下，cursor 在视觉上一直所在的位置定格——零瞬移。
 *
 * 副作用极小：长时间播放时若 dt 累加与 mpv 内部时钟有微小漂移，最多
 * 几十毫秒；用户只在 seek 或文件切换时才能看到 cursor 重新对齐，正常播放
 * 中视觉上几乎完美连续。
 */
export function useCursorAnimation(
  ref: RefObject<HTMLElement | null>,
  updater: (el: HTMLElement, progress: number) => void,
): void {
  useEffect(() => {
    let raf = 0;

    // 虚拟播放头：我们自己维护的"当前位置"，不直接读 mpv
    let displayed: number | null = null;
    let lastTickTime = 0;
    let lastSeenPosition = -Infinity;

    // > 这个差距判定为 seek，需要 snap 到 mpv 报的新位置（单位：秒）
    const SEEK_THRESHOLD = 0.3;

    const tick = () => {
      const s = usePlayerStore.getState();
      const now = performance.now();

      // 拖动：直接 snap 到鼠标位置
      if (s.dragPosition !== null) {
        displayed = s.dragPosition;
        lastSeenPosition = s.position;
        lastTickTime = now;
      } else {
        // 第一次或长时间停滞（>1s，可能 tab 后台过）→ 初始化
        if (displayed === null || now - lastTickTime > 1000) {
          displayed = s.position;
          lastSeenPosition = s.position;
          lastTickTime = now;
        } else {
          const dt = (now - lastTickTime) / 1000;
          lastTickTime = now;

          // 检测 seek：mpv 报的 position 跟我们的 displayed 差距过大
          if (s.position !== lastSeenPosition) {
            const diff = s.position - displayed;
            if (Math.abs(diff) > SEEK_THRESHOLD) {
              // seek（或文件切换、单帧 step 之类大幅跳变）→ snap
              displayed = s.position;
            }
            // 小幅差距：忽略，相信我们自己的 dt 累加，避免 IPC 抖动
            lastSeenPosition = s.position;
          }

          // 播放：dt 累加；暂停：不累加（自然冻结）
          if (s.isPlaying) {
            displayed += dt * s.speed;
            if (s.duration > 0 && displayed > s.duration) displayed = s.duration;
            if (displayed < 0) displayed = 0;
          }
        }
      }

      const progress =
        s.duration > 0
          ? Math.max(0, Math.min(1, displayed / s.duration))
          : 0;

      const el = ref.current;
      if (el) updater(el, progress);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ref, updater]);
}
