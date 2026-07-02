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
 * 订阅,所有订阅者绝对同步。父组件重渲染不会触动模块级状态。(§6.22)
 *
 * ★ 时钟同步模型:陈旧度补偿 + PLL 式连续微调 ★ (§6.30)
 *
 * store.position 走 "mpv → Rust → Tauri IPC → JS 事件循环 → rAF 消费"
 * 链路,消费时已经陈旧了 5~40ms(audio-only 静默场景靠 1Hz poll 时可达
 * ~1s)。旧实现 snap 时直接采用原始值、之后纯 dt 自由累加,<300ms 的误差
 * 永远不会被修正 —— 每次 snap 注入一个随机常量滞后,暂停/恢复循环还会
 * 累积 mpv pause-retreat 偏移。现在:
 *
 *   1. 陈旧度补偿(age compensation):外推真值 = position +
 *      (now − 观测时刻) × speed。只统计"播放持续进行"的时段 —— 从
 *      max(positionObservedAt, playStartedAt) 起算,否则恢复播放的瞬间
 *      会把整个暂停时长外推进去。上限 AGE_CAP,再旧视为停滞不外推。
 *   2. 连续微调(slew):播放中每帧 displayed 向外推真值指数收敛
 *      (时间常数 SLEW_TAU),修正速率钳制在 ±MAX_SLEW_FRAC×speed 内,
 *      光标永不倒退、肉眼不可见;|误差| > SNAP_THRESHOLD(真 seek /
 *      循环回绕 / 长停滞)才硬 snap。
 *   3. 暂停时维持"完全不自动修正"(见下)。
 *
 * ★ 暂停"瞬移/退回"双向问题 ★
 *
 * 暂停时 mpv 的 position 不能可靠反映"用户视觉上的真实位置",它会因
 * mpv 内部状态(trailing buffered time-pos、暂停回退一帧)有几十 ms 的
 * 多方向浮动,任何"自动 snap"都会让 cursor 跟着抖(§6.22 两轮教训)。
 * 所以暂停时完全不自动 snap,只在用户主动操作(seek/单帧步进/loadFile)
 * 时由调用方显式 forcePlayheadSnap() 触发一次性 snap。暂停期间残留的
 * 几十 ms 偏差会在恢复播放后被 slew 在 ~1s 内无感修正掉。
 */
type PlayheadCb = (displayed: number, progress: number) => void;

const subscribers = new Set<PlayheadCb>();
let rafId = 0;

let displayed: number | null = null;
let lastTickTime = 0;
let lastSeenPosition = -Infinity;
let wasPlaying = false;
let pauseFreezeUntil = 0;
let playStartedAt = 0; // 最近一次恢复播放的本地时刻;外推起点下界
let forceNextSnap = false; // 用户主动操作触发一次性 snap

const SNAP_THRESHOLD = 0.3; // |外推真值−displayed| > 300ms → 硬 snap(真 seek 兜底)
const SLEW_TAU = 0.4; // 微调时间常数(s):误差按 e^(−t/τ) 收敛
const MAX_SLEW_FRAC = 0.1; // 微调速率上限:±10% 播放速度(保证光标永不倒退)
const AGE_CAP = 1.5; // 外推上限(s):覆盖 1Hz fallback poll;再旧视为停滞
const PAUSE_FREEZE_MS = 280; // playing → pausing 冻结窗(吸收 mpv 最后几次 time-pos)

// —— 调试统计(SyncDebugOverlay 消费,Ctrl+Shift+D 查看) ——
let dbgErrMs: number | null = null;
let dbgAgeMs = 0;
let dbgObsCount = 0;
let dbgSnapCount = 0;
let dbgLastObservedAt = -1;

type Store = ReturnType<typeof usePlayerStore.getState>;

/** 外推 mpv 真值:补偿 store.position 从观测到消费之间的陈旧度。 */
function agedTarget(s: Store, now: number, playing: boolean): number {
  if (!playing) return s.position; // 暂停时钟不走,原始值即真值(帧 PTS)
  const base = Math.max(s.positionObservedAt, playStartedAt);
  const age = Math.min(Math.max(0, (now - base) / 1000), AGE_CAP);
  return s.position + age * s.speed;
}

function tick(): void {
  const s = usePlayerStore.getState();
  const now = performance.now();

  // "真在播":mpv idle=yes 且无文件时 pause=false → isPlaying=true,但
  // position 永远 0 —— 若按播放处理,displayed 会空转累加、被外推上限
  // 拽回,0.3s 一次锯齿 snap(UI 不可见但污染统计)。fileLoaded 门控掉。
  const playing = s.isPlaying && s.fileLoaded;

  // 调试:统计 position 观测(store 写入)次数
  if (s.positionObservedAt !== dbgLastObservedAt) {
    dbgLastObservedAt = s.positionObservedAt;
    dbgObsCount += 1;
  }

  // 恢复播放的瞬间:记录外推起点下界(此前的暂停时长不属于媒体时钟)
  if (!wasPlaying && playing) {
    playStartedAt = now;
  }

  if (s.dragPosition !== null) {
    // 拖动中:displayed 钉在拖动值。注意**不消费** lastSeenPosition ——
    // 松手时 seek 的 position 回报可能落在 ControlBar 200ms 乐观窗内,
    // 若在这里静默吞掉,forceNextSnap 会一直等不到"下一次 position 变化"
    // (暂停态下永远不来),cursor 便停在点击处而非 mpv 实际落点。
    displayed = s.dragPosition;
    lastTickTime = now;
    pauseFreezeUntil = 0;
  } else if (displayed === null || now - lastTickTime > 1000) {
    // 首次或长时间停滞(tab 后台/睡眠):用外推真值作为起点
    displayed = agedTarget(s, now, playing);
    lastSeenPosition = s.position;
    lastTickTime = now;
    pauseFreezeUntil = 0;
  } else {
    const dt = (now - lastTickTime) / 1000;
    lastTickTime = now;

    // 从 playing 转 pausing 的那一帧:启动冻结窗
    if (wasPlaying && !playing) {
      pauseFreezeUntil = now + PAUSE_FREEZE_MS;
    }
    const inPauseFreeze = !playing && now < pauseFreezeUntil;

    if (!inPauseFreeze && s.position !== lastSeenPosition) {
      // 用户主动操作(seek/单帧步进/loadFile)后的第一次 position 回报:
      // 无视阈值直接 snap。暂停时 agedTarget 退化为原始 position,
      // 即精确帧 PTS;除此之外暂停时不自动 snap(§6.22)。
      if (forceNextSnap) {
        displayed = agedTarget(s, now, playing);
        forceNextSnap = false;
        dbgSnapCount += 1;
      }
      lastSeenPosition = s.position;
    }

    if (playing) {
      displayed += dt * s.speed;

      // PLL 式连续微调:每帧向外推真值收敛
      const target = agedTarget(s, now, playing);
      const err = target - displayed;
      if (Math.abs(err) > SNAP_THRESHOLD) {
        // 真 seek(外部触发/loop 回绕)或长停滞 → 硬 snap
        displayed = target;
        dbgSnapCount += 1;
      } else {
        const maxStep = MAX_SLEW_FRAC * s.speed * dt;
        const step = Math.max(
          -maxStep,
          Math.min(maxStep, err * (dt / SLEW_TAU)),
        );
        displayed += step;
      }

      if (s.duration > 0 && displayed > s.duration) displayed = s.duration;
      if (displayed < 0) displayed = 0;
    }
  }

  wasPlaying = playing;

  const dispVal = displayed ?? 0;

  // 调试残差:播放中 displayed 相对外推真值的偏差(ms,正=光标落后)
  dbgErrMs =
    playing && s.dragPosition === null && displayed !== null
      ? (agedTarget(s, now, playing) - dispVal) * 1000
      : null;
  dbgAgeMs = s.positionObservedAt > 0 ? now - s.positionObservedAt : 0;

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
    playStartedAt = 0;
    forceNextSnap = false;
    dbgErrMs = null;
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

export interface PlayheadDebugInfo {
  /** 播放中:外推真值 − displayed(ms,正=光标落后);暂停/拖动中为 null */
  errMs: number | null;
  /** 距上次 position 观测的时长(ms) */
  ageMs: number;
  /** position 观测(store 写入)累计次数 */
  obsCount: number;
  /** 硬 snap 累计次数(forced + 阈值) */
  snapCount: number;
}

/** SyncDebugOverlay 每帧读取;放模块级避免任何 React 开销。 */
export function getPlayheadDebugInfo(): PlayheadDebugInfo {
  return {
    errMs: dbgErrMs,
    ageMs: dbgAgeMs,
    obsCount: dbgObsCount,
    snapCount: dbgSnapCount,
  };
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
