import { useEffect, useRef, type RefObject } from "react";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import {
  createPlayheadClock,
  type PlayheadDebugInfo,
} from "../lib/playheadClock";

export type { PlayheadDebugInfo };

/**
 * 全局虚拟播放头(virtual playhead) —— 模块级单例。
 *
 * ★ 为什么必须单例 ★
 *
 * 旧实现把 displayed / lastTickTime 等放在 hook 内的局部变量,且 useEffect
 * 依赖 [ref, updater]。父组件(如 ControlBar)在 mpv 高频 time-pos 事件下
 * 重渲染,子组件 ProgressFill/Thumb 也重渲染 → 传入的 inline updater 引用变
 * → useEffect cleanup + 重 setup → displayed 被重置为 s.position。表现:暂停
 * 瞬间 cursor "瞬移"到 mpv 报的最后位置;播放中持续微抖。
 *
 * 单例模式:整个 app 只有一个 rAF tick 推进 displayed,无论多少 cursor
 * 订阅,所有订阅者绝对同步。父组件重渲染不会触动模块级状态。(§6.22)
 *
 * 时钟算法(audio-pts 从动 / 陈旧度补偿 / PLL 微调 / 暂停只在用户操作与视频停帧时移动)在
 * lib/playheadClock.ts(纯逻辑,可离线回放测试);这里只负责 rAF 与订阅者分发。
 * tick 用 rAF 回调的帧时间戳而非 performance.now():同一帧所有订阅者共用
 * vsync 对齐的时刻,dt 不带回调排队抖动。(§6.32)
 */
type PlayheadCb = (displayed: number, progress: number) => void;

const subscribers = new Set<PlayheadCb>();
let rafId = 0;
const clock = createPlayheadClock();

function tick(ts: number): void {
  const s = usePlayerStore.getState();
  const displayed = clock.tick(
    {
      // "真在播":mpv idle=yes 且无文件时 pause=false → isPlaying=true,但
      // position 永远 0 —— fileLoaded 门控掉,空闲期不外推。
      playing: s.isPlaying && s.fileLoaded,
      position: s.position,
      positionObservedAt: s.positionObservedAt,
      audioPts: s.audioPts,
      audioPtsObservedAt: s.audioPtsObservedAt,
      restartAt: s.restartAt,
      // 以 track-list 的 selected 为准(start-file 清空、file-loaded 刷新，不跨文件残留)；
      // 音轨表未知(加载中)时为 null，不能当成"无音轨"提前解除钉住
      hasAudio: s.tracksKnown ? s.tracks.some((t) => t.type === "audio" && t.selected) : null,
      // 真正的视频画面(封面图 / 静态图不算)：暂停时光标对齐到屏幕停住的那一帧(§6.33)
      hasVideo: s.tracksKnown
        ? s.tracks.some((t) => t.type === "video" && t.selected && !t.albumart && !t.image)
        : null,
      eof: s.eofReached,
      speed: s.speed,
      duration: s.duration,
      dragPosition: s.dragPosition,
      loopFile: useSettingsStore.getState().playbackMode === "loop-single",
    },
    ts,
  );

  const progress =
    s.duration > 0 ? Math.max(0, Math.min(1, displayed / s.duration)) : 0;

  for (const cb of subscribers) {
    cb(displayed, progress);
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
    clock.reset();
  }
}

/**
 * 用户主动操作(单帧步进、seek、loadFile 等)调用此函数,告诉虚拟播放头
 * "接下来 mpv 的 position 回报是这次操作的落点,无视阈值直接 snap"。
 *
 * 必须紧贴 mpv IPC 之前调用:早于它到达的 audio-pts 视为操作前的旧值。
 * awaitRestart:该操作会产生 mpv playback-restart(seek / loadfile);帧步进传 false。
 * target:预期落点(绝对 seek 的目标 / 相对 seek 的 mpv 当前位置 + 位移 / 加载为 0),
 * 用来识别哪条回报才是本次操作的落点。详见 lib/playheadClock.ts 的 op 说明。
 *
 * 设计上不直接 displayed = newPos,因为此时 mpv IPC 还在飞,store.position
 * 还是旧值;只在回报到达后 snap。
 */
export function forcePlayheadSnap(awaitRestart = true, target: number | null = null): void {
  clock.forceSnap(performance.now(), awaitRestart, target);
}

/** mpv 此刻的 time-pos 估计(相对 seek 的基准)：播放中按观测后流逝时间外推 */
export function mpvPositionNow(): number {
  const s = usePlayerStore.getState();
  let p = s.position;
  if (s.isPlaying && s.fileLoaded && s.positionObservedAt > 0) {
    // 起点不早于恢复播放时刻：暂停期间的时长不属于媒体时钟
    const from = Math.max(s.positionObservedAt, s.playingSince);
    p += (Math.min(1500, Math.max(0, performance.now() - from)) / 1000) * s.speed;
  }
  return p;
}

/** SyncDebugOverlay 每帧读取;放模块级避免任何 React 开销。 */
export function getPlayheadDebugInfo(): PlayheadDebugInfo {
  return clock.debug();
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
