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
 * ★ 暂停"瞬移/退回"双向问题 ★
 *
 * 之前观察:
 *   - playing→pausing 瞬间,mpv 可能发出最后几次 time-pos(buffered),
 *     这些值比 dt 累加的 displayed 略前 → cursor 向前"跳" (第一次报告)
 *   - 加 PAUSE_FREEZE_MS 冻结窗 + 暂停时 SEEK_THRESHOLD_PAUSED=5ms 自动
 *     snap → 冻结窗结束后,mpv 内部回退到上一帧(暂停显示前一帧),
 *     displayed = dt 累加值 > mpv 报的 position → snap 让 cursor 退回
 *     (第二次报告)
 *
 * 根因:暂停时 mpv 的 position 不能可靠地反映"用户视觉上的真实位置",
 * 它会因 mpv 内部状态有几十 ms 的浮动。任何"自动 snap"都会让 cursor
 * 跟着这种浮动抖动。
 *
 * 终极方案:**暂停时完全不自动 snap**,只在用户主动操作(seek/单帧
 * 步进/loadFile)时,由调用方显式 forcePlayheadSnap() 触发一次性 snap。
 * 这样暂停时 cursor 永远稳定不动(代价:跟 mpv 实际位置可能有几十 ms
 * 偏差,肉眼不可见)。播放时仍维持 SEEK_THRESHOLD_PLAYING=300ms 自动
 * snap 兜底真实 seek 检测。
 */
type PlayheadCb = (displayed: number, progress: number) => void;

const subscribers = new Set<PlayheadCb>();
let rafId = 0;

let displayed: number | null = null;
let lastTickTime = 0;
let lastSeenPosition = -Infinity;
let wasPlaying = false;
let pauseFreezeUntil = 0;
let forceNextSnap = false; // 用户主动操作触发一次性 snap

const SEEK_THRESHOLD_PLAYING = 0.3; // 播放时 >300ms 才认为是 seek(兜底)
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
      // snap 触发条件:
      //   1. 用户主动操作刚刚调过 forcePlayheadSnap() → 必 snap
      //   2. 播放中且 mpv position 突变 > 300ms → 真实 seek 兜底
      //   暂停时不再"自动 snap",彻底消除 mpv 内部状态浮动导致的退回
      const shouldSnap =
        forceNextSnap ||
        (s.isPlaying && Math.abs(diff) > SEEK_THRESHOLD_PLAYING);
      if (shouldSnap) {
        displayed = s.position;
      }
      forceNextSnap = false;
      lastSeenPosition = s.position;
    } else if (forceNextSnap) {
      // mpv 还没回报新 position(IPC 在飞),先标记;下次 position 变化时再 snap
      // 不立即重置 forceNextSnap,直到真正 snap 完成
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
    forceNextSnap = false;
  }
}

/**
 * 用户主动操作(单帧步进、seek、loadFile 等)调用此函数,告诉虚拟播放头
 * "下次 mpv position 变化是预期的,无视阈值直接 snap 到新位置"。
 *
 * 必须在 mpv IPC 之前调用,否则可能错过(虽然单例 tick 一直跑,标记直到
 * mpv 回报新 position 才消费)。
 *
 * 设计上不直接 displayed = newPos,因为此时 mpv IPC 还在飞,store.position
 * 还是旧值;只在 store.position 实际变化的下一帧 snap。
 */
export function forcePlayheadSnap(): void {
  forceNextSnap = true;
  // 立即解除冻结窗,允许 snap 立即生效(用户暂停后单帧步进不应被
  // PAUSE_FREEZE 280ms 吞掉视觉反馈)
  pauseFreezeUntil = 0;
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
