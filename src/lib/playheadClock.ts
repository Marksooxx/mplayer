/**
 * 虚拟播放头的时钟从动算法（纯逻辑，无 React / store 依赖，可离线回放测试）。
 * 由 hooks/useCursorAnimation.ts 的单例 rAF 每帧驱动（§6.22 / §6.30 / §6.32）。
 *
 * ★ 时钟源：audio-pts 优先 ★
 * mpv 的 time-pos 不是"正在响的音频"：
 *   - 有视频时它是刚送进 VO 队列的视频帧 pts，比声音超前 1–2 帧（实测 33–49ms）；
 *   - loop-file=inf 回绕时解码端先 seek 回 0，time-pos 立刻归 0 并冻结，而 AO
 *     缓冲里上一圈的尾巴还要再响约 250ms（光标因此每圈领先约 250ms）；
 *   - seek / 起播时先报目标值，音频要再过 20–50ms 才真正开始。
 * audio-pts = 已写入音频 pts − speed × 驱动延迟，正是"正在响"的位置：seek 后到
 * 音频真正开始前为 null，回绕尾巴期间为负值（上一圈的 duration + v）。
 *
 * ★ 用户操作（op）★
 * seek / 帧步进 / loadFile 前由调用方 forceSnap() 登记一个 op。事件到达 JS 的
 * 时刻不能说明 mpv 何时产生它（插件每个事件单独 spawn 转发，操作发出后、mpv
 * 执行前产生的旧值照样晚到），所以 seek / 加载类 op 以 mpv 的 playback-restart
 * 事件作为"完成"标记：
 *   - 暂停态：跟随 op 之后、完成之前的 time-pos 回报（先到的可能是操作前在途的旧值，
 *     后到的覆盖它），完成后停止跟随（此后的回报可能是 AO 缓冲造成的虚值）；若完成
 *     标记被乱序转发得比落点早，采用完成后的第一条。帧步进没有 restart 事件，暂停中
 *     一直跟随到下一次操作 / 恢复播放；暂停跟随最多 PAUSED_FOLLOW_MS。
 *   - seek / 加载类 op 带目标提示（预期落点）时，只认与目标相符的回报：操作前的旧位置
 *     和 AO 虚值都在容差外；完成后迟迟没有相符回报则显示目标本身。
 *   - 播放态：光标钉在回报的落点（hold，不走），直到完成之后的首个有效 audio-pts
 *     再对齐：它必须与落点（或目标）相容，允许范围随完成后流逝的时间扩大、循环按环形
 *     距离算（乱序晚到的旧值被拒绝）；对齐带不后退保护（小幅落后时等外推追上），解除后
 *     短时间内新到的音频观测若有偏差直接对齐。暂停中登记、之后恢复播放的，只用恢复
 *     之后的音频观测。音轨表未知（加载中）时不按"无音轨"处理。
 *   - 早于最近一次 op 的 audio-pts 一律作废；超时（HOLD_TIMEOUT_MS）兜底。
 * audio-pts 与 time-pos 的值都超过 STALL_CAP_MS 没有前进 → stall：外推封顶、不越过，恢复后光标若超前
 * 则原地等声音追上（§6.35，App 首次打开视频时 mpv 约停 400ms）；
 * 回绕等内部原因 audio-pts 短暂缺失 → coast（按 dt 惯性前进、不修正）；
 * 无音轨 / audio-pts 长期缺失或停更 → 退回 time-pos 外推（旧行为）。
 *
 * ★ 陈旧度补偿 + PLL 式微调（§6.30）★
 * 外推真值 = 观测值 + (now − max(观测时刻, 恢复播放时刻)) × speed，上限 AGE_CAP；
 * 播放中 displayed 按 dt 前进，并以 SLEW_TAU 指数收敛到外推真值，修正速率钳制
 * ±MAX_SLEW_FRAC × speed（光标永不倒退）；|误差| > SNAP_THRESHOLD 才硬 snap。
 * 变速时 mpv 时钟会真实回退一小段（实测 1→1.5 倍约 146ms），下一次观测直接 snap。
 * 单曲循环时 displayed 与误差都按 duration 取模，回绕处连续无停顿。
 *
 * ★ 暂停：只在少数情况下移动光标（§6.22 / §6.33）★
 * 暂停中不按 mpv 的回报自动修正（暂停后纯音频的 audio-pts 会变成 AO 缓冲虚值，跟着它
 * 光标会抖）：只在用户操作（op）后跟随 position 回报；长时间无 rAF（后台）后恢复也保持原值，
 * 除非停滞期间由播放转为暂停（停滞前的光标已过时，取最新 time-pos）。
 * 例外：有视频画面时，播放中按暂停，光标对齐到屏幕停住的那一帧。mpv 会把已排进 VO 队列的
 * 帧照常显示出来，这一帧就是暂停时最新的 time-pos，比暂停瞬间的声音位置超前 1–3 帧
 * （实测 48/48，24/30/60fps；暂停之后 mpv 不再报 time-pos）。事件可能被乱序转发，
 * 所以暂停时连同播放中缓存的回报、暂停后 PAUSE_FRAME_WINDOW_MS 内取相容回报中最靠后的一条
 * (单曲循环回绕处例外：屏幕帧可能落后于声音，放宽落后界)
 * (EOF 自动暂停例外：之后报来的是音频尾巴，只认暂停那一刻)。恢复播放时声音从暂停
 * 位置接着响，光标原地等声音追上这一帧再走（推断画面也会停到那时，未取帧验证），不倒退。
 */

export interface ClockInput {
  /** isPlaying && fileLoaded */
  playing: boolean;
  /** mpv time-pos */
  position: number;
  positionObservedAt: number;
  /** mpv audio-pts；null = 不可用 */
  audioPts: number | null;
  audioPtsObservedAt: number;
  /** 最近一次 mpv playback-restart 事件到达时刻（seek / 加载完成标记） */
  restartAt: number;
  /** 当前选中了音轨（aid ≠ no）；null = 本文件的音轨表还没拿到（加载中），不能当"无音轨" */
  hasAudio: boolean | null;
  /** 当前选中了真正的视频轨（封面图 / 静态图不算）；null = 音轨表未知。只有 true 时暂停才对齐画面帧 */
  hasVideo?: boolean | null;
  /** mpv eof-reached(keep-open 播到结尾会随之自动暂停) */
  eof?: boolean;
  speed: number;
  duration: number;
  /** 进度条拖动中的目标位置 */
  dragPosition: number | null;
  /** 单曲循环（mpv loop-file=inf） */
  loopFile: boolean;
}

export type ClockSource =
  | "audio"
  | "hold"
  | "coast"
  | "stall"
  | "time-pos"
  | "paused"
  | "drag";

export interface PlayheadDebugInfo {
  /** 当前时钟源 */
  src: ClockSource;
  /** 播放中：外推真值 − displayed（ms，正 = 光标落后）；无真值时为 null */
  errMs: number | null;
  /** 当前时钟源距上次观测的时长（ms） */
  ageMs: number;
  /** 当前时钟源观测（store 写入）累计次数 */
  obsCount: number;
  /** 硬 snap 累计次数（op 落点 + 阈值 + 变速） */
  snapCount: number;
  /** 播放中 time-pos 与 audio-pts 各自外推后的差（ms）；有视频时即 time-pos 的超前量 */
  tpMinusApMs: number | null;
}

export const SNAP_THRESHOLD = 0.3; // |外推真值−displayed| > 300ms → 硬 snap(真 seek 兜底)
export const SLEW_TAU = 0.4; // 微调时间常数(s):误差按 e^(−t/τ) 收敛
export const MAX_SLEW_FRAC = 0.1; // 微调速率上限:±10% 播放速度(保证光标永不倒退)
export const AGE_CAP = 1.5; // 外推上限(s):覆盖 1Hz fallback poll;再旧视为停滞
/** audio-pts 最近一次有效后，缺失多久内按惯性前进（回绕尾巴前约 50ms 为 null） */
export const COAST_MS = 400;
/** 播放中 audio-pts 超过这么久没更新视为停更，退回 time-pos（1Hz poll 兜底） */
export const AUDIO_STALE_MS = 600;
/** 播放中等 op 完成 + 音频时钟恢复的最长时间；超时退回普通外推 */
export const HOLD_TIMEOUT_MS = 2000;
/** hold 解除时若外推值落后于光标不超过这么多，保持光标等外推追上（不倒退） */
export const NO_BACKSTEP_S = 0.15;
/**
 * 帧步进(无 restart 事件)后，这么久之内不因音频时钟解除钉住：mpv frame-step 会
 * 先报 pause=0、约 30ms 后与落点同批报 pause=1；同批事件被插件乱序转发时，
 * 不能让中途到达的 audio-pts 抢先解除钉住、吞掉随后的落点。
 */
export const FRAME_STEP_GRACE_MS = 200;
/** 暂停中跟随 op 回报的最长时间(restart 永不到 / 帧步进之后的无关回报) */
export const PAUSED_FOLLOW_MS = 3000;
/**
 * 解除钉住时，外推音频时钟与落点的最大允许偏差。seek 后音频从落点起播，真实值只比
 * 落点多"起播后流逝的时间"；更远的是操作前产生、被插件乱序转发晚到的旧值。
 */
export const RELEASE_AHEAD_S = 0.25;
/** 解除钉住时，外推音频时钟允许落后于落点的量(帧步进后 audio-pts 约滞后 1 帧) */
export const RELEASE_BEHIND_S = 0.1;
/**
 * seek 目标提示的相符容差：hr-seek 落点 = 目标或其所在视频帧(低帧率 ≤0.1s)。
 * 操作前的旧位置、暂停中 AO 缓冲虚值(实测约 −0.18s)都在容差外，被拒绝。
 */
export const LANDING_TOL_S = 0.12;
/** seek 完成后这么久仍无相符回报：直接显示目标本身(精确 seek 的落点就是它) */
export const TARGET_FALLBACK_MS = 300;
/** 解除钉住后这段时间内，新观测偏差超过 POST_RELEASE_SNAP_S 直接对齐(不慢慢 slew) */
export const POST_RELEASE_WINDOW_MS = 500;
export const POST_RELEASE_SNAP_S = 0.03;
/**
 * 有视频时，播放中暂停后这段时间内光标对齐到 time-pos(屏幕停住的帧)；之后不再跟随。
 * 暂停后 mpv 不再报 time-pos，窗口只为兜住乱序转发(暂停前刚产生的回报晚于 pause 到达)。
 */
export const PAUSE_FRAME_WINDOW_MS = 150;
/**
 * 暂停帧与暂停瞬间光标的最大距离(×max(1, speed))：正常是 1–3 帧(≤ 约 85ms)。更远的回报
 * 不属于这次暂停(事件停更、1Hz poll 兜底的陈旧值等)，不吸附，保持原位置。
 */
export const PAUSE_FRAME_MAX_S = 0.3;
/**
 * 暂停帧允许落后于暂停瞬间光标的量(×max(1, speed))。有音轨时光标 = 声音位置，屏幕帧只会超前
 * (实测 0–3 帧)，只容事件链延迟；无音轨时光标按 time-pos 外推，会越过最后一帧 ≤1 帧。更靠后的
 * 是乱序晚到的旧值(到达顺序 ≠ 产生顺序)，不采用。
 */
export const PAUSE_FRAME_BEHIND_S = 0.05;
export const PAUSE_FRAME_BEHIND_NOAUDIO_S = 0.1;
/**
 * 放宽的落后界：单曲循环边界(末尾 / 刚回绕的开头 LOOP_TAIL_S 内)、暂停前处于 coast 或 stall。
 * 回绕处 mpv 处理暂停命令要 94–164ms(实测 5/10 次；其他情况 <8ms)，其间光标还在前进，而屏幕
 * 停在已入队的帧上；App 内还见过屏幕帧落后声音约 113ms 的一次。停滞中光标本就走在真实位置前面
 * (≤ STALL_CAP_MS)。光标会比屏幕帧超前至多约 150ms。
 */
export const PAUSE_FRAME_BEHIND_COAST_S = 0.2;
/** 单曲循环末尾 / 开头这么长算"回绕处"：time-pos 约提前 250ms 归零，暂停处理最多再晚约 160ms */
export const LOOP_TAIL_S = 0.35;
/** 播放中保留的最近 time-pos 条数(暂停停帧候选；0.3s 内 60fps 约 18 条) */
export const RECENT_POS_MAX = 32;
/**
 * op 结束 / 变速之后这么久内不往缓存收回报：此时乱序晚到的可能是跳变之前的旧值，
 * 数值上可能比新值更"靠后"(小幅向后 seek、变速回退)，取最大值会选错。缓存只用于稳定
 * 播放；静默期内退回只看 store 当前值。
 */
export const RECENT_POS_QUIET_MS = 300;
/**
 * 恢复播放后等声音追上暂停帧：声音从暂停位置接着响，但起播本身还有 10–50ms 延迟，所以不按
 * 超前量定时，而是等恢复之后的 audio-pts 追上这一帧；超过 超前量/speed + 这么久仍没追上就放弃。
 */
export const RESUME_HOLD_SLACK_MS = 150;
/**
 * 起播 / 卡顿停滞(§6.35)：audio-pts 与 time-pos 的**值**都超过这么久没有前进 → mpv 的时钟多半没在走
 * (实测 App 首次打开视频时约停 400ms，期间 audio-pts 只走了 33ms)。按值而不按"有没有新回报"：
 * 卡住时 1Hz poll 拿回的是同一个 time-pos，不算前进。外推封顶在"最后音频观测 + 这么久"，
 * 不再越过；恢复后光标若已超前，原地等声音追上(复用恢复等声)，不倒退。
 * 正常播放两路回报的最大间隔：纯音频约 100ms、视频约 65ms(录制实测)，恢复播放后首条 ≤51ms。
 */
export const STALL_CAP_MS = 150;
/** 停滞恢复时光标超前声音超过这么多才原地等待；更小的交给常规 slew */
export const STALL_CATCHUP_MIN_S = 0.02;

export interface PlayheadClock {
  /** 推进一帧；返回本帧 displayed（秒） */
  tick(input: ClockInput, now: number): number;
  /**
   * 用户操作（seek / 帧步进 / loadFile）登记。awaitRestart：该操作会产生 mpv
   * playback-restart 事件（seek / 加载）；mpv 的 frame-step 命令不会。
   */
  forceSnap(now: number, awaitRestart?: boolean, target?: number | null): void;
  reset(): void;
  debug(): PlayheadDebugInfo;
}

interface Op {
  at: number;
  awaitRestart: boolean;
  /** 预期落点(秒)：绝对 seek 的目标、相对 seek 的 mpv 当前位置 + 位移、加载为 0；帧步进 null */
  target: number | null;
  /** 已采用的最后一条 time-pos 回报的观测时刻 */
  lastApplied: number;
  /** 已采用过本次操作的落点 */
  landed: boolean;
  /** 因与落点不相容而拒绝过的 audio-pts 观测时刻(不再重复考虑) */
  rejectedAudioObs: number;
}

/** seek / 加载类 op：收到本次操作之后的 playback-restart 即完成；帧步进不等 */
function opDone(op: Op, inp: ClockInput): boolean {
  return !op.awaitRestart || inp.restartAt > op.at;
}

/** 目标提示按时长钳制(越界 seek mpv 会停在两端) */
function opTarget(op: Op, inp: ClockInput): number | null {
  if (op.target === null || !Number.isFinite(op.target)) return null;
  const t = Math.max(0, op.target);
  return inp.duration > 0 ? Math.min(t, inp.duration) : t;
}

function aged(value: number, observedAt: number, floor: number, now: number, speed: number): number {
  const base = Math.max(observedAt, floor);
  const age = Math.min(Math.max(0, (now - base) / 1000), AGE_CAP);
  return value + age * speed;
}

/** 循环模式下的最短有向误差：把 err 折到 (−d/2, d/2] */
function wrapErr(err: number, d: number): number {
  const m = (((err + d / 2) % d) + d) % d;
  return m - d / 2;
}

export function createPlayheadClock(): PlayheadClock {
  let displayed: number | null = null;
  let lastTick = 0;
  let lastSeenAudioObs = -1;
  let lastPositionObs = -1;
  let wasPlaying = false;
  let playStartedAt = 0; // 最近一次恢复播放的时刻;外推起点下界

  let op: Op | null = null;
  let lastOpAt = -Infinity; // 早于它的 audio-pts 描述的是操作前的位置
  let lastAudioValidAt = -Infinity;
  let lastSpeed: number | null = null;
  let speedChangedAt = -Infinity;
  let resyncAfterResume = false; // 恢复播放后的首个新观测：光标落后则直接向前对齐
  let postReleaseUntil = 0; // 解除钉住后的快速对齐窗口
  // —— 暂停停帧(§6.33) ——
  let pauseFrameUntil = 0; // 暂停后对齐画面帧的窗口截止
  let pauseFrameArmedAt = 0;
  let pauseFrameFrom = 0; // 暂停瞬间的光标(= 声音位置)
  let pauseFrameBehind = PAUSE_FRAME_BEHIND_S; // 本次暂停的落后界(未乘 speed)
  let pauseFrameOldest = 0; // 本次暂停接受的最早到达时刻
  let pauseFrameLead: number | null = null; // 已对齐的帧相对 pauseFrameFrom 的超前量(s)
  // 暂停这一刻(含播放中缓存的回报)的最佳候选：EOF 时退回它，不跟随之后报来的音频尾巴
  let pauseFrameAtArm: { pos: number; d: number } | null = null;
  let resumeHoldUntil = 0; // 恢复播放后原地等声音追上暂停帧，最迟到这个时刻
  // 播放中(无 op)到达的最近 time-pos：store 只留最后到达的一条，乱序晚到的旧值会盖掉更新的值；
  // 暂停时从这里和 store 当前值中取与暂停瞬间光标相容的最靠后一条
  let recentPos: { pos: number; at: number }[] = [];
  let recentPosQuietUntil = 0;
  let stallAhead = false; // 本轮停滞期间光标按封顶外推走过，恢复时要检查是否超前(跨暂停保留)
  // 两路回报"值有变化"的最近时刻(停滞判定用)；值不变的回报(卡住时的 poll)不算前进
  let lastAudioVal: number | null = null;
  let audioProgressAt = -Infinity;
  let lastPosVal: number | null = null;
  let posProgressAt = -Infinity;
  // 事件断了但时钟在走：time-pos 在前进而 audio-pts 已超过 AUDIO_STALE_MS 没有回报(音频先于视频
  // 结束、事件链只剩 1Hz poll)。此时不做停滞判定，沿用 time-pos 外推；audio-pts 再前进时解除
  let audioSilentButRunning = false;

  function clearPauseFrame(): void {
    pauseFrameUntil = 0;
    pauseFrameLead = null;
    pauseFrameAtArm = null;
    resumeHoldUntil = 0;
  }

  // —— 调试统计 ——
  let dbgSrc: ClockSource = "paused";
  let dbgErrMs: number | null = null;
  let dbgAgeMs = 0;
  let dbgObsCount = 0;
  let dbgSnapCount = 0;
  let dbgTpAp: number | null = null;

  function audioValue(inp: ClockInput, now: number): number | null {
    if (inp.hasAudio === false || inp.audioPts === null || !Number.isFinite(inp.audioPts)) return null;
    if (inp.audioPtsObservedAt <= lastOpAt) return null;
    // 事件链停更：陈旧的 audio-pts 外推到 AGE_CAP 会冻结目标、造成锯齿回拉
    if (inp.playing && now - Math.max(inp.audioPtsObservedAt, playStartedAt) > AUDIO_STALE_MS) {
      return null;
    }
    let v = inp.audioPts;
    // 回绕尾巴：负值 = 上一圈末尾还在响
    if (v < 0 && inp.loopFile && inp.duration > 0) v += inp.duration;
    return v;
  }

  /** 播放中的外推真值；null = 本帧不修正（coast） */
  function target(inp: ClockInput, now: number): { value: number | null; src: ClockSource } {
    // "事件断了但时钟在走"的豁免只在 time-pos 最近仍在前进时有效(1Hz poll 间隔内)
    const silentExempt = audioSilentButRunning && now - posProgressAt < AGE_CAP * 1000;
    if (
      inp.playing &&
      inp.hasAudio === true &&
      !silentExempt &&
      inp.audioPts !== null &&
      Number.isFinite(inp.audioPts) &&
      inp.audioPtsObservedAt > lastOpAt &&
      now - Math.max(audioProgressAt, posProgressAt, playStartedAt) > STALL_CAP_MS
    ) {
      // 两路的值都停着：mpv 时钟多半没在走，外推封顶在"最后音频观测 + STALL_CAP_MS"。
      // 不受 AUDIO_STALE_MS 限制：卡住超过 600ms 也保持停住，不在那一刻跳去 time-pos 外推
      let v = inp.audioPts;
      if (v < 0 && inp.loopFile && inp.duration > 0) v += inp.duration;
      return { value: v + (STALL_CAP_MS / 1000) * inp.speed, src: "stall" };
    }
    const av = audioValue(inp, now);
    if (av !== null) {
      return { value: aged(av, inp.audioPtsObservedAt, playStartedAt, now, inp.speed), src: "audio" };
    }
    if (inp.hasAudio !== false && now - lastAudioValidAt < COAST_MS) return { value: null, src: "coast" };
    return {
      value: aged(inp.position, inp.positionObservedAt, playStartedAt, now, inp.speed),
      src: "time-pos",
    };
  }

  function applyReport(inp: ClockInput): void {
    displayed = inp.position;
    if (op) {
      op.lastApplied = inp.positionObservedAt;
      op.landed = true;
    }
    dbgSnapCount += 1;
  }

  function tick(inp: ClockInput, now: number): number {
    const playing = inp.playing;

    // —— 观测记账 ——
    const audioObsNew = inp.audioPtsObservedAt !== lastSeenAudioObs;
    if (audioObsNew) lastSeenAudioObs = inp.audioPtsObservedAt;
    const audioValidNow = audioValue(inp, now) !== null;
    if (audioObsNew && audioValidNow) lastAudioValidAt = inp.audioPtsObservedAt;
    const positionObsNew = inp.positionObservedAt !== lastPositionObs;
    if (positionObsNew) lastPositionObs = inp.positionObservedAt;
    // 停滞判定：记录两路"值有变化"的时刻
    if (audioObsNew && inp.audioPts !== null) {
      if (inp.audioPts !== lastAudioVal) {
        audioProgressAt = inp.audioPtsObservedAt;
        audioSilentButRunning = false;
      }
      lastAudioVal = inp.audioPts;
    }
    if (positionObsNew) {
      if (inp.position !== lastPosVal) {
        posProgressAt = inp.positionObservedAt;
        if (playing && inp.hasAudio === true && now - Math.max(inp.audioPtsObservedAt, playStartedAt) > AUDIO_STALE_MS) {
          audioSilentButRunning = true;
        }
      }
      lastPosVal = inp.position;
    }

    if (lastSpeed !== null && inp.speed !== lastSpeed) {
      speedChangedAt = now;
      recentPos = []; // 变速时 mpv 时钟会回退一小段，之前的回报不再是"最靠后"
      recentPosQuietUntil = now + RECENT_POS_QUIET_MS;
    }
    lastSpeed = inp.speed;
    const hadOp = op !== null;

    // 稳定播放中(无 op、不在 op 结束 / 变速后的静默期)缓存到达的 time-pos(暂停停帧候选)
    if (positionObsNew && playing && op === null && inp.dragPosition === null && now >= recentPosQuietUntil) {
      recentPos.push({ pos: inp.position, at: inp.positionObservedAt });
      if (recentPos.length > RECENT_POS_MAX) recentPos.shift();
    }

    // 恢复播放的瞬间:记录外推起点下界(此前的暂停时长不属于媒体时钟)
    if (!wasPlaying && playing) {
      playStartedAt = now;
      resyncAfterResume = op === null;
      // 暂停时对齐到了超前的画面帧：声音从暂停位置接着响，原地等它追上这一帧
      const lead = op === null && inp.hasAudio === true ? (pauseFrameLead ?? 0) : 0;
      clearPauseFrame();
      if (lead > 0) {
        resumeHoldUntil = now + (lead / Math.max(inp.speed, 0.01)) * 1000 + RESUME_HOLD_SLACK_MS;
      }
    }
    if (wasPlaying && !playing) {
      clearPauseFrame();
      if (op === null && inp.dragPosition === null && inp.hasVideo === true && displayed !== null) {
        pauseFrameArmedAt = now;
        pauseFrameUntil = now + PAUSE_FRAME_WINDOW_MS;
        pauseFrameFrom = displayed;
        // dbgSrc 此时是上一帧(最后一个播放帧)的时钟源
        // 单曲循环边界：末尾或刚回绕到开头(光标已取模、audio-pts 还是上一圈的负值尾巴)。
        // op 结束 / 变速后的静默期内不放宽：那时晚到的可能是跳变前的旧帧
        const edge = inp.loopFile && inp.duration > 0 ? Math.min(displayed, inp.duration - displayed) : Infinity;
        const loopEdge = edge < LOOP_TAIL_S * Math.max(1, inp.speed) && now >= recentPosQuietUntil;
        // 停滞中暂停：最后一条 time-pos 就是真实的最后一帧，只是早于常规的新鲜度窗口
        pauseFrameOldest = now - PAUSE_FRAME_MAX_S * Math.max(1, inp.speed) * 1000;
        if (dbgSrc === "stall" && Number.isFinite(posProgressAt)) pauseFrameOldest = Math.min(pauseFrameOldest, posProgressAt);
        pauseFrameBehind =
          dbgSrc === "coast" || dbgSrc === "stall" || loopEdge
            ? PAUSE_FRAME_BEHIND_COAST_S
            : inp.hasAudio === true
              ? PAUSE_FRAME_BEHIND_S
              : PAUSE_FRAME_BEHIND_NOAUDIO_S;
      }
    }
    if (inp.dragPosition !== null) {
      clearPauseFrame();
      recentPos = [];
    }

    let err: number | null = null;
    let src: ClockSource = playing ? "time-pos" : "paused";

    if (inp.dragPosition !== null) {
      // 拖动中:displayed 钉在拖动值。op 回报是电平触发(按观测时刻比对 store)，
      // 松手后落在 ControlBar 200ms 乐观窗内的 seek 回报会在拖动结束后补上。
      displayed = inp.dragPosition;
      lastTick = now;
      src = "drag";
    } else if (displayed === null) {
      displayed = playing ? (target(inp, now).value ?? inp.position) : inp.position;
      lastTick = now;
    } else if (now - lastTick > 1000) {
      // 长时间停滞(tab 后台/睡眠/最小化)后恢复:播放中直接对齐；一直暂停则保持原值
      // (§6.22：暂停时 mpv 的位置不可信，只有用户操作才能移动光标)。停滞期间由播放转为
      // 暂停：停滞前的光标已过时数秒，取停滞期间报来的最新 time-pos
      if (playing && !op) displayed = target(inp, now).value ?? inp.position;
      else if (!playing && wasPlaying && !op && inp.positionObservedAt > lastTick) {
        // EOF 时最新值可能是超出时长的音频尾巴，按时长钳制
        displayed = inp.duration > 0 ? Math.min(inp.position, inp.duration) : inp.position;
        if (pauseFrameUntil > 0) {
          pauseFrameFrom = displayed;
          pauseFrameLead = 0;
          pauseFrameAtArm = { pos: displayed, d: 0 };
        }
      }
      resumeHoldUntil = 0;
      lastTick = now;
    } else {
      const dt = (now - lastTick) / 1000;
      lastTick = now;

      // 暂停态没有 op 时不采用任何 position 回报(涵盖旧版 280ms 冻结窗：暂停瞬间
      // mpv 还会报"多走 50ms"的尾值、恢复时再回退)。op 进行中则跟随 ——
      // mpv 的 frame-step 会先报 pause=0 再报 pause=1，落点就跟在 pause=1 后面。

      // —— op 回报 ——
      // 属于本次操作的回报 = op 之后、完成标记(playback-restart)之前到达的 time-pos。
      // 按观测时刻判定而不是按处理先后：落点与 restart 常在同一帧内先后到达。
      // 完成之后的回报不再跟随(暂停中可能是 AO 缓冲造成的虚值，实测回退 184ms)；
      // 例外：本次操作还没有任何落点时(restart 被乱序转发得比落点早)，采用完成后的第一条。
      if (op) {
        const fresh =
          inp.positionObservedAt > op.at && inp.positionObservedAt !== op.lastApplied;
        const tgt = opTarget(op, inp);
        const done = opDone(op, inp);
        let follow: boolean;
        if (op.awaitRestart && tgt !== null) {
          // 有目标提示：只认与目标相符的回报(操作前的旧位置、AO 虚值都在容差外)；
          // 暂停中持续跟随相符回报(视频完成后才到的"真实显示帧"也会采用)
          let d = inp.position - tgt;
          if (inp.loopFile && inp.duration > 0) d = wrapErr(d, inp.duration);
          const matches = Math.abs(d) <= LANDING_TOL_S;
          follow = matches && (!playing || !done || !op.landed);
        } else if (op.awaitRestart) {
          const beforeDone = !done || inp.positionObservedAt <= inp.restartAt;
          follow = beforeDone || !op.landed;
        } else {
          // 帧步进(不等 restart)：暂停中一直跟随到下一次操作 / 恢复播放
          follow = !playing;
        }
        if (!playing && now - op.at > PAUSED_FOLLOW_MS) follow = false;
        if (fresh && follow) applyReport(inp);
        // 完成后迟迟没有相符的回报：显示目标本身
        if (tgt !== null && done && !op.landed && now - inp.restartAt > TARGET_FALLBACK_MS) {
          displayed = tgt;
          op.landed = true;
          dbgSnapCount += 1;
        }
      }

      // —— 暂停停帧 ——
      // 暂停后窗口内：time-pos(最近 PAUSE_FRAME_MAX_S 内到达、与暂停瞬间光标相容)就是
      // 屏幕停住的帧；取最靠后的一条(播放中 time-pos 单调递增，用户暂停后 mpv 不再报)。
      // 暂停那一刻连同播放中缓存的回报一起考虑：乱序晚到的旧值盖掉 store 也不影响
      if (!playing && !op && now <= pauseFrameUntil) {
        const k = Math.max(1, inp.speed);
        const behind = pauseFrameBehind * k;
        const consider = (pos: number, at: number): void => {
          if (at < pauseFrameOldest) return; // 太旧
          if (inp.duration > 0 && pos > inp.duration) return; // 超出时长的是音频尾巴，不是画面帧
          let d = pos - pauseFrameFrom;
          if (inp.loopFile && inp.duration > 0) d = wrapErr(d, inp.duration);
          if (d < -behind || d > PAUSE_FRAME_MAX_S * k) return; // 不属于这次暂停
          if (pauseFrameLead === null || d > pauseFrameLead) {
            displayed = pos;
            pauseFrameLead = d;
            dbgSnapCount += 1;
          }
        };
        if (now === pauseFrameArmedAt) {
          for (const r of recentPos) consider(r.pos, r.at);
          consider(inp.position, inp.positionObservedAt);
          pauseFrameAtArm = pauseFrameLead === null ? null : { pos: displayed, d: pauseFrameLead };
        } else if (positionObsNew) {
          consider(inp.position, inp.positionObservedAt);
        }
        if (inp.eof) {
          // EOF 自动暂停：之后 mpv 还会报音频尾巴(实测比末帧多 46ms、超出 duration)。退回暂停
          // 那一刻的最佳候选(= 末帧)并关窗；pause 先于 eof-reached 到达的乱序同样处理
          if (pauseFrameAtArm) {
            displayed = pauseFrameAtArm.pos;
            pauseFrameLead = pauseFrameAtArm.d;
          } else if (pauseFrameLead !== null) {
            // 暂停那一刻没有合格候选：撤回窗口内采用的(尾巴)值，回到暂停瞬间的光标
            displayed = pauseFrameFrom;
            pauseFrameLead = null;
          }
          pauseFrameUntil = 0;
        }
      }
      if (!playing) recentPos = [];

      if (playing) {
        const opActive = op !== null;
        let alignedThisFrame = false;
        if (op) {
          const done = opDone(op, inp);
          const timedOut = now - Math.max(op.at, playStartedAt) > HOLD_TIMEOUT_MS;
          // 音频时钟必须来自：op 之后；seek 类还要在完成(restart)之后；
          // 暂停中登记、之后才恢复播放的，要在恢复之后(暂停时的 audio-pts 可能是 AO 缓冲虚值)
          const readyAfter = Math.max(
            op.at,
            op.awaitRestart ? inp.restartAt : -Infinity,
            playStartedAt > op.at ? playStartedAt : -Infinity,
          );
          const audioReady =
            done &&
            audioValidNow &&
            inp.audioPtsObservedAt >= readyAfter &&
            inp.audioPtsObservedAt !== op.rejectedAudioObs &&
            (op.awaitRestart || now - op.at > FRAME_STEP_GRACE_MS);
          // 相容性参照：已采用的落点；还没有落点时用目标提示
          const ref = op.landed ? displayed : opTarget(op, inp);
          if (audioReady) {
            const t = target(inp, now).value;
            let compatible = true;
            if (t !== null && ref !== null) {
              // 音频从落点起播，合法值只比落点多"完成 / 恢复之后流逝的时间"
              const elapsed = (Math.max(0, now - readyAfter) / 1000) * inp.speed;
              let d = t - ref;
              if (inp.loopFile && inp.duration > 0) d = wrapErr(d, inp.duration);
              compatible = d >= -RELEASE_BEHIND_S && d <= RELEASE_AHEAD_S + elapsed;
            }
            if (!compatible) {
              // 与落点 / 目标不相容：操作前产生、乱序晚到的旧值，等下一条
              op.rejectedAudioObs = inp.audioPtsObservedAt;
            } else {
              // 不后退：外推值小幅落后于光标(例如帧步进后 audio-pts 滞后约 1 帧)时
              // 保持光标，交给 slew 以 90% 速度等它追上
              const guarded = t !== null && t < displayed && displayed - t < NO_BACKSTEP_S;
              if (t !== null && !guarded) {
                displayed = t;
                dbgSnapCount += 1;
                alignedThisFrame = true;
              }
              postReleaseUntil = guarded ? 0 : now + POST_RELEASE_WINDOW_MS;
              op = null;
            }
          } else if (done && inp.hasAudio === false && (op.landed || ref !== null)) {
            // 确认无音轨：落点已采用(或按目标)，接着按 time-pos 外推
            if (!op.landed && ref !== null) displayed = ref;
            op = null;
          } else if (timedOut) {
            op = null; // 音频迟迟不出(解码失败等)：退回普通外推，别让光标一直钉住
          }
        }

        // 恢复播放后等声音追上暂停帧：只认恢复之后的音频观测(暂停中的 audio-pts 是 AO 缓冲虚值)
        let waitAudio = false;
        if (!op && resumeHoldUntil > 0) {
          const t =
            audioValidNow && inp.audioPtsObservedAt > playStartedAt ? target(inp, now).value : null;
          let d = t === null ? -Infinity : t - displayed;
          if (t !== null && inp.loopFile && inp.duration > 0) d = wrapErr(d, inp.duration);
          if (t !== null && d >= 0) {
            displayed = t; // 追上了：从这里跟着声音走(向前，至多一个观测间隔)
            alignedThisFrame = true;
            resyncAfterResume = false;
            resumeHoldUntil = 0;
            stallAhead = false;
          } else if (now >= resumeHoldUntil) {
            resumeHoldUntil = 0; // 迟迟没追上：交回常规外推 / 微调
          } else {
            waitAudio = true;
          }
        }

        const loopMode = inp.loopFile && inp.duration > 0;
        let tg: { value: number | null; src: ClockSource } | null = null;
        if (!op && !waitAudio) {
          tg = target(inp, now);
          if (tg.src !== "stall" && stallAhead) {
            // 停滞结束 / 恢复播放：光标按封顶外推走在了声音前面 → 原地等它追上，不倒退。
            // 等待期间保留 stallAhead(等待被暂停打断、超时后仍无前进时会再次等待)，追上才清除
            let e = tg.src === "audio" && tg.value !== null ? tg.value - displayed : 0;
            if (loopMode) e = wrapErr(e, inp.duration);
            if (tg.src === "audio" && e < -STALL_CATCHUP_MIN_S && -e <= SNAP_THRESHOLD) {
              resumeHoldUntil = now + (-e / Math.max(inp.speed, 0.01)) * 1000 + RESUME_HOLD_SLACK_MS;
              postReleaseUntil = 0;
              waitAudio = true;
            } else {
              stallAhead = false;
              if (tg.src === "audio" && tg.value !== null && e > 0 && e <= SNAP_THRESHOLD) {
                // 时钟其实在走、只是回报变慢：封顶让光标落后了，一步向前跟上(不以 10% 速率慢追)
                displayed = tg.value;
                alignedThisFrame = true;
              }
            }
          }
        }

        if (op || waitAudio) {
          src = "hold"; // 钉在落点 / 暂停帧 / 停滞后等声音，不走
        } else if (tg && tg.src === "stall" && tg.value !== null) {
          // 停滞：照常前进但不越过封顶值(也不后退)，不做 slew / snap
          src = "stall";
          let room = tg.value - displayed;
          if (loopMode) room = wrapErr(room, inp.duration);
          if (!alignedThisFrame) displayed += Math.max(0, Math.min(dt * inp.speed, room));
          stallAhead = true;
          postReleaseUntil = 0;
        } else if (tg) {
          src = tg.src;
          if (!alignedThisFrame) displayed += dt * inp.speed;

          if (tg.src !== "audio") postReleaseUntil = 0; // 时钟源切走就关闭快速对齐窗口
          if (tg.value !== null) {
            const freshObs = tg.src === "audio" ? inp.audioPtsObservedAt : inp.positionObservedAt;
            const loop = inp.loopFile && inp.duration > 0;
            let e = tg.value - displayed;
            if (loop) e = wrapErr(e, inp.duration);
            const firstObsAfterResume = resyncAfterResume && freshObs > playStartedAt;
            if (firstObsAfterResume) resyncAfterResume = false;
            if (freshObs > speedChangedAt && speedChangedAt > -Infinity) {
              // 变速：时钟真实回退/前跳，下一次新观测直接对齐
              displayed = tg.value;
              speedChangedAt = -Infinity;
              dbgSnapCount += 1;
              e = 0;
            } else if (
              now < postReleaseUntil &&
              tg.src === "audio" &&
              audioObsNew &&
              Math.abs(e) > POST_RELEASE_SNAP_S
            ) {
              // 刚解除钉住就发现偏差：多半是用来解除的那条音频是乱序晚到的旧值
              // (小幅 seek 时它能通过相容性检查)，直接对齐，不以 10% 速率慢追
              displayed = tg.value;
              postReleaseUntil = 0;
              dbgSnapCount += 1;
              e = 0;
            } else if (firstObsAfterResume && e > 0 && e <= SNAP_THRESHOLD) {
              // 恢复后音频真实起点相对暂停位置有 −30~+15ms 浮动：落后就一步追上
              // (向前跳、光标刚起步，不可见)；超前仍走 slew，保持永不倒退
              displayed = tg.value;
              e = 0;
            } else if (Math.abs(e) > SNAP_THRESHOLD) {
              // 真 seek(外部触发)或长停滞 → 硬 snap
              displayed = tg.value;
              dbgSnapCount += 1;
              e = 0;
            } else {
              const maxStep = MAX_SLEW_FRAC * inp.speed * dt;
              displayed += Math.max(-maxStep, Math.min(maxStep, e * (dt / SLEW_TAU)));
              e = tg.value - displayed;
              if (loop) e = wrapErr(e, inp.duration);
            }
            err = e;
          }
        }

        // 单曲循环按 duration 取模(钉在落点时不取模：用户可能正好 seek 到末尾)
        if (inp.loopFile && inp.duration > 0 && !opActive) {
          displayed = ((displayed % inp.duration) + inp.duration) % inp.duration;
        } else {
          if (inp.duration > 0 && displayed > inp.duration) displayed = inp.duration;
          if (displayed < 0) displayed = 0;
        }
      }
    }

    wasPlaying = playing;
    if (hadOp && op === null) recentPosQuietUntil = now + RECENT_POS_QUIET_MS;

    // —— 调试 ——
    const usingAudio = src === "audio" || src === "hold" || src === "coast" || src === "stall";
    if (usingAudio ? audioObsNew : positionObsNew) dbgObsCount += 1;
    const obsAt = usingAudio ? inp.audioPtsObservedAt : inp.positionObservedAt;
    dbgSrc = src;
    dbgErrMs = playing && err !== null ? err * 1000 : null;
    dbgAgeMs = obsAt > 0 ? now - obsAt : 0;
    const av = audioValue(inp, now);
    dbgTpAp =
      playing && av !== null && inp.audioPts !== null && inp.audioPts >= 0
        ? (aged(inp.position, inp.positionObservedAt, playStartedAt, now, inp.speed) -
            aged(av, inp.audioPtsObservedAt, playStartedAt, now, inp.speed)) *
          1000
        : null;

    return displayed ?? 0;
  }

  return {
    tick,
    forceSnap(now: number, awaitRestart = true, target: number | null = null) {
      op = { at: now, awaitRestart, target, lastApplied: -1, landed: false, rejectedAudioObs: -1 };
      lastOpAt = now;
      clearPauseFrame();
      recentPos = [];
      stallAhead = false;
      audioSilentButRunning = false;
      lastAudioVal = null;
      lastPosVal = null;
    },
    reset() {
      displayed = null;
      lastTick = 0;
      lastSeenAudioObs = -1;
      lastPositionObs = -1;
      wasPlaying = false;
      playStartedAt = 0;
      op = null;
      lastOpAt = -Infinity;
      lastAudioValidAt = -Infinity;
      lastSpeed = null;
      speedChangedAt = -Infinity;
      resyncAfterResume = false;
      postReleaseUntil = 0;
      clearPauseFrame();
      recentPos = [];
      recentPosQuietUntil = 0;
      stallAhead = false;
      lastAudioVal = null;
      audioProgressAt = -Infinity;
      lastPosVal = null;
      posProgressAt = -Infinity;
      audioSilentButRunning = false;
      dbgErrMs = null;
      dbgTpAp = null;
    },
    debug() {
      return {
        src: dbgSrc,
        errMs: dbgErrMs,
        ageMs: dbgAgeMs,
        obsCount: dbgObsCount,
        snapCount: dbgSnapCount,
        tpMinusApMs: dbgTpAp,
      };
    },
  };
}
