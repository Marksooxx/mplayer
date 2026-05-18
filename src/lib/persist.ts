const POSITIONS_KEY = "mplayer:positions";
const SETTINGS_KEY = "mplayer:settings";

type PositionMap = Record<string, number>;

interface Settings {
  volume: number;
  muted: boolean;
  speed: number;
}

const defaultSettings: Settings = {
  volume: 80,
  muted: false,
  speed: 1,
};

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) } as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}

export function loadSettings(): Settings {
  return readJSON<Settings>(SETTINGS_KEY, defaultSettings);
}

export function saveSettings(s: Settings): void {
  writeJSON(SETTINGS_KEY, s);
}

function loadPositions(): PositionMap {
  return readJSON<PositionMap>(POSITIONS_KEY, {});
}

export function getResumePosition(path: string): number | undefined {
  const map = loadPositions();
  return map[path];
}

export function savePosition(path: string, position: number): void {
  if (!path || !Number.isFinite(position) || position < 1) return;
  const map = loadPositions();
  map[path] = Math.floor(position);
  writeJSON(POSITIONS_KEY, map);
}

export function clearPosition(path: string): void {
  const map = loadPositions();
  if (path in map) {
    delete map[path];
    writeJSON(POSITIONS_KEY, map);
  }
}

export function clearAllPositions(): void {
  try {
    localStorage.removeItem(POSITIONS_KEY);
  } catch {
    /* ignore */
  }
}

export function countSavedPositions(): number {
  try {
    return Object.keys(loadPositions()).length;
  } catch {
    return 0;
  }
}
