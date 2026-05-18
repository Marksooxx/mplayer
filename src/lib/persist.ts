import { storeGet, storeSet, storeDelete } from "./storage";

// store.json 三个键
const KEY_UI = "ui";              // settingsStore UI 设置 + 快捷键
const KEY_PLAYER = "player";      // 音量 / 静音 / 倍速
const KEY_POSITIONS = "positions"; // path → seconds

// ---------- 播放器偏好（volume/mute/speed）----------
interface PlayerPrefs {
  volume: number;
  muted: boolean;
  speed: number;
}

const defaultPrefs: PlayerPrefs = {
  volume: 80,
  muted: false,
  speed: 1,
};

let prefsCache: PlayerPrefs | null = null;

export async function loadSettings(): Promise<PlayerPrefs> {
  if (prefsCache) return prefsCache;
  const raw = await storeGet<Partial<PlayerPrefs>>(KEY_PLAYER);
  prefsCache = { ...defaultPrefs, ...(raw ?? {}) };
  return prefsCache;
}

export function loadSettingsSync(): PlayerPrefs {
  // 给同步上下文用：返回缓存或默认（首次启动若 store 还没 bootstrap 完则用默认）
  return prefsCache ?? defaultPrefs;
}

export function saveSettings(s: PlayerPrefs): void {
  prefsCache = s;
  void storeSet(KEY_PLAYER, s);
}

// ---------- 播放进度 ----------
type PositionMap = Record<string, number>;

let positionsCache: PositionMap | null = null;

export async function loadPositionsAsync(): Promise<PositionMap> {
  if (positionsCache) return positionsCache;
  const raw = await storeGet<PositionMap>(KEY_POSITIONS);
  positionsCache = raw ?? {};
  return positionsCache;
}

function ensurePositionsCache(): PositionMap {
  if (!positionsCache) positionsCache = {};
  return positionsCache;
}

export function getResumePosition(path: string): number | undefined {
  return positionsCache?.[path];
}

export function savePosition(path: string, position: number): void {
  if (!path || !Number.isFinite(position) || position < 1) return;
  const map = ensurePositionsCache();
  map[path] = Math.floor(position);
  void storeSet(KEY_POSITIONS, map);
}

export function clearPosition(path: string): void {
  if (!positionsCache) return;
  if (path in positionsCache) {
    delete positionsCache[path];
    void storeSet(KEY_POSITIONS, positionsCache);
  }
}

export function clearAllPositions(): void {
  positionsCache = {};
  void storeDelete(KEY_POSITIONS);
}

export function countSavedPositions(): number {
  return positionsCache ? Object.keys(positionsCache).length : 0;
}

// ---------- UI settings 通用 getter/setter ----------
export async function loadUiRaw(): Promise<unknown | undefined> {
  return storeGet<unknown>(KEY_UI);
}

export function persistUi(value: unknown): void {
  void storeSet(KEY_UI, value);
}

export const STORE_KEYS = {
  UI: KEY_UI,
  PLAYER: KEY_PLAYER,
  POSITIONS: KEY_POSITIONS,
};
