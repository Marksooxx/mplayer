import { useEffect, useRef, type RefObject } from "react";
import { usePlayerStore } from "../store/playerStore";

/**
 * 全局虚拟播放头(virtual playhead) —— 模块级单例。
 *
 * ★ 为什么必须单例 ★
 *
 * 旧实现把 displayed / lastTickTime 等放在 hook 内的局部变量,且 useEffect
 * 依赖 [ref, updater]。父组件(如 ControlBar)在 mpv 每 ~33ms 一次的
 * time-pos 事件下重渲染,子组件 ProgressFill/Thumb 也重渲染 → 传入的
 * inline updater 引用变 → useEffect cleanup + 重 setup → displayed 被
 * 重置为 s.position。表现:暂停瞬间 cursor "瞬移"到 mpv 报的最后位置;
 * 播放中持续微抖(每次 reset 都对齐到 mpv 离散值,丢失 dt 累加的连续性)。
 *
 * 单例模式:整个 app 只有一个 rAF tick 推进 displayed,无论多少 cursor
 * 订阅,所有订阅者绝对同步。父组件重渲染不会触动模块级状态。
 *
 * ★ 暂停瞬移修复 ★
 *
 * 从 playing → pausing 转换的瞬间,mpv 还会发出最后几次 time-pos 事件
 * (buffered frames + IPC 延迟),它们的值比 dt 累加的 displayed 略前。
 * 这些事件如果触发 snap,cursor 会向前"跳"几十毫秒。
 *
 * 方案:暂停转换瞬间启动 PAUSE_FREEZE_MS 冻结窗,期间忽略所有 mpv
 * position 更新。窗口结束后:
 *   - 播放时 diff > 300ms 才认为是用户主动 seek
 *   - 暂停时 diff > 5ms 即 snap(让 Ctrl+←/→ 单帧步进 ~33ms 有视觉反馈)
 */
type PlayheadCb = (displayed: number, progress: number) => void;

const subscribers = new Set<PlayheadCb>();
let rafId = 0;

let displayed: number | null = null;
let lastTickTime = 0;
let lastSeenPosition = -Infinity;
let wasPlaying = false;
let pauseFreezeUntil = 0;

const SEEK_THRESHOLD_PLAYING = 0.3; // 播放时 >300ms 才认为是 seek
const SEEK_THRESHOLD_PAUSED = 0.005; // 暂停时 >5ms 即 snap(单帧 ~33ms 触发)
const PAUSE_FREEZE_MS = 280; // playing → pausing 冻结窗(吸收 mpv 最后几次 time-pos)

function tick(): void {
  const s = usePlayerStore.getState();
  const now = performance.now();

  if (s.dragPosition !== null) {
    displayed = s.dragPosition;
    lastSeenPosition = s.position;
    lastTickTime = now;
    wasPlaying = s.isPlaying;
    pauseFreezeUntil = 0;
  } else if (displayed === null || now - lastTickTime > 1000) {
    // 首次或长时间停滞(tab 后台/睡眠):用 mpv 当前 position 作为起点
    displayed = s.position;
    lastSeenPosition = s.position;
    lastTickTime = now;
    pauseFreezeUntil = 0;
    wasPlaying = s.isPlaying;
  } else {
    const dt = (now - lastTickTime) / 1000;
    lastTickTime = now;

    // 从 playing 转 pausing 的那一帧:启动冻结窗
    if (wasPlaying && !s.isPlaying) {
      pauseFreezeUntil = now + PAUSE_FREEZE_MS;
    }
    const inPauseFreeze = !s.isPlaying && now < pauseFreezeUntil;

    if (!inPauseFreeze && s.position !== lastSeenPosition) {
      const diff = s.position - displayed;
      const threshold = s.isPlaying ? SEEK_THRESHOLD_PLAYING : SEEK_THRESHOLD_PAUSED;
      if (Math.abs(diff) > threshold) {
        displayed = s.position;
      }
      lastSeenPosition = s.position;
    }

    if (s.isPlaying) {
      displayed += dt * s.speed;
      if (s.duration > 0 && displayed > s.duration) displayed = s.duration;
      if (displayed < 0) displayed = 0;
    }
    wasPlaying = s.isPlaying;
  }

  const dispVal = displayed ?? 0;
  const progress =
    s.duration > 0 ? Math.max(0, Math.min(1, dispVal / s.duration)) : 0;

  for (const cb of subscribers) {
    cb(dispVal, progress);
  }

  rafId = requestAnimationFrame(tick);
}

function ensureTicking(): void {
  if (rafId === 0) {
    rafId = requestAnimationFrame(tick);
  }
}

function stopIfNoSubscribers(): void {
  if (subscribers.size === 0 && rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    displayed = null;
    lastSeenPosition = -Infinity;
    wasPlaying = false;
    pauseFreezeUntil = 0;
  }
}

/**
 * 通用订阅。callback 接收(displayed seconds, progress 0-1)。
 * 整个 app 共享同一个 rAF tick,所有订阅者每帧同步。
 */
export function useVirtualPlayhead(cb: PlayheadCb): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    const wrapped: PlayheadCb = (d, p) => cbRef.current(d, p);
    subscribers.add(wrapped);
    ensureTicking();
    return () => {
      subscribers.delete(wrapped);
      stopIfNoSubscribers();
    };
  }, []);
}

/** 便捷封装:把 progress(0-1) 写入指定 element 的 callback */
export function useCursorAnimation(
  ref: RefObject<HTMLElement | null>,
  updater: (el: HTMLElement, progress: number) => void,
): void {
  useVirtualPlayhead((_d, p) => {
    const el = ref.current;
    if (el) updater(el, p);
  });
}
