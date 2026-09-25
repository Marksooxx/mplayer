import {
  command,
  setProperty,
  getProperty,
} from "tauri-plugin-libmpv-api";
import { usePlayerStore, type TrackInfo } from "../store/playerStore";
import { forcePlayheadSnap, mpvPositionNow } from "../hooks/useCursorAnimation";

/**
 * seek 的预期落点(虚拟播放头的目标提示，§6.32)。连按方向键时前一次 seek 还没落地，
 * store 里的位置仍是旧值，而 mpv 会把排队中的相对 seek 累加(10→15→20→25)：上一次
 * seek 尚未执行时以它的目标为基准累计，已执行(或超时)后改用 mpv 当前位置。
 * "已执行"看最新的位置回报是否已在上一次目标附近(播放中允许随时间前进)——不用
 * playback-restart 判断，因为它无法区分完成的是哪一次 seek。
 */
let lastSeek: { target: number; at: number } | null = null;
const SEEK_CHAIN_MS = 1500;
const SEEK_LANDED_TOL = 0.12;

function clampToDuration(t: number): number {
  const d = usePlayerStore.getState().duration;
  const v = Math.max(0, t);
  return d > 0 ? Math.min(v, d) : v;
}

function lastSeekPending(): boolean {
  const last = lastSeek;
  if (!last) return false;
  const now = performance.now();
  if (now - last.at > SEEK_CHAIN_MS) return false;
  const s = usePlayerStore.getState();
  if (s.positionObservedAt <= last.at) return true; // 操作之后还没有任何位置回报
  const ahead = ((now - last.at) / 1000) * Math.max(0, s.speed) + SEEK_LANDED_TOL;
  const d = s.position - last.target;
  return !(d >= -SEEK_LANDED_TOL && d <= ahead);
}

function relativeTarget(delta: number): number {
  const base = lastSeekPending() && lastSeek ? lastSeek.target : mpvPositionNow();
  return clampToDuration(base + delta);
}

/** 诊断 / 离线测试用：最近一次登记的 seek 预期落点 */
export function lastSeekForDebug(): { target: number; at: number } | null {
  return lastSeek;
}

function registerSeek(target: number): void {
  lastSeek = { target, at: performance.now() };
  forcePlayheadSnap(true, target);
}

export async function loadFile(path: string): Promise<void> {
  lastSeek = null;
  forcePlayheadSnap(true, 0);
  await command("loadfile", [path, "replace"]);
}

export async function setPaused(paused: boolean): Promise<void> {
  await setProperty("pause", paused);
}

/**
 * 切换播放/暂停 —— 从 mpv 真实状态读取，不依赖 React store 的 isPlaying。
 * 修复"初始事件错过导致 isPlaying 一直 false"的 race。
 */
export async function togglePause(): Promise<void> {
  try {
    const paused = await getProperty("pause", "flag");
    if (paused === null) return;
    await setProperty("pause", !paused);
  } catch (err) {
    console.error("[mpv] togglePause failed", err);
  }
}

export async function seekRelative(deltaSeconds: number): Promise<void> {
  registerSeek(relativeTarget(deltaSeconds));
  await command("seek", [deltaSeconds, "relative"]);
}

export async function seekAbsolute(seconds: number): Promise<void> {
  registerSeek(clampToDuration(seconds));
  await command("seek", [seconds, "absolute"]);
}

export async function frameStep(): Promise<void> {
  lastSeek = null;
  forcePlayheadSnap(false); // mpv frame-step 不产生 playback-restart
  await command("frame-step");
}

export async function frameBackStep(): Promise<void> {
  // frame-back-step 的落点 time-pos 晚于它自己的 playback-restart 约 55ms 才到，
  // 按帧步进语义登记(暂停中一直跟随回报)，不以 restart 为完成标记
  lastSeek = null;
  forcePlayheadSnap(false);
  await command("frame-back-step");
}

/**
 * 多帧跳转。优先用 fps 算精确时间 seek（一次 IPC），失败回退到逐帧调用。
 * - count > 0 向前；count < 0 向后；0 不动。
 * - audio-only 拿不到 fps 时按 0.04s/帧（25fps 兜底）算时间。
 */
export async function frameStepBy(count: number): Promise<void> {
  if (count === 0) return;
  try {
    let fps: number | null = null;
    try {
      const v = await getProperty("container-fps", "double");
      if (typeof v === "number" && v > 0) fps = v;
    } catch { /* ignore */ }
    if (fps === null) fps = 25; // 兜底
    const delta = count / fps;
    // 紧贴 seek 登记操作：查 fps 的 IPC 期间到达的回报都是操作前的旧值
    registerSeek(relativeTarget(delta));
    // relative+exact 保证按时间精确 seek 而不是跳到关键帧
    await command("seek", [delta, "relative+exact"]);
  } catch (err) {
    console.warn("[mpv] frameStepBy seek failed, falling back to frame-step loop", err);
    const n = Math.abs(count);
    for (let i = 0; i < n; i++) {
      if (count > 0) await frameStep();
      else await frameBackStep();
    }
  }
}

export async function setVolumeProp(volume: number): Promise<void> {
  await setProperty("volume", Math.max(0, Math.min(100, volume)));
}

export async function setMutedProp(muted: boolean): Promise<void> {
  await setProperty("mute", muted);
}

export async function setSpeedProp(speed: number): Promise<void> {
  await setProperty("speed", speed);
}

export async function setSubtitleTrack(sid: number | "no"): Promise<void> {
  await setProperty("sid", sid as unknown as string | number);
}

export async function setAudioTrack(aid: number | "no"): Promise<void> {
  await setProperty("aid", aid as unknown as string | number);
}

/** 加载外部字幕文件,加载后 mpv 自动 select 为当前 sid */
export async function addSubtitle(path: string): Promise<void> {
  await command("sub-add", [path, "select"]);
}

/** 字幕延迟(秒);正值=字幕延后显示 */
export async function setSubDelay(seconds: number): Promise<void> {
  await setProperty("sub-delay", seconds);
}
export async function getSubDelay(): Promise<number> {
  try {
    const v = await getProperty("sub-delay", "double");
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

export async function stopPlayback(): Promise<void> {
  await command("stop");
}

interface MpvTrackRaw {
  id: number;
  type: string;
  title?: string;
  lang?: string;
  selected?: boolean;
  codec?: string;
}

export function parseTrackList(raw: unknown): TrackInfo[] {
  if (!Array.isArray(raw)) return [];
  return (raw as MpvTrackRaw[])
    .filter((t) => t && (t.type === "video" || t.type === "audio" || t.type === "sub"))
    .map((t) => ({
      id: t.id,
      type: t.type as "video" | "audio" | "sub",
      title: t.title,
      lang: t.lang,
      selected: !!t.selected,
      codec: t.codec,
    }));
}

export async function getCurrentTracks(): Promise<TrackInfo[]> {
  try {
    const raw = await getProperty("track-list", "node");
    return parseTrackList(raw);
  } catch {
    return [];
  }
}
