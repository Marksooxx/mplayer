/**
 * 应用持久化存储封装。
 * 物理位置：%APPDATA%\dev.mark.mplayer\store.json （Windows）
 * 一个单文件、人可读的 JSON。通过 tauri-plugin-store 读写、autoSave 100ms 防抖。
 *
 * 三个逻辑分区：
 *   - "ui"        ← settingsStore 的所有 UI 偏好 + 快捷键绑定
 *   - "player"    ← 播放器偏好（volume / muted / speed）
 *   - "positions" ← 每文件上次播放位置 { [path]: seconds }
 */
import { Store, load } from "@tauri-apps/plugin-store";

const STORE_FILE = "store.json";

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { defaults: {}, autoSave: 100 });
  }
  return storePromise;
}

export async function storeGet<T>(key: string): Promise<T | undefined> {
  const s = await getStore();
  const v = await s.get<T>(key);
  return v ?? undefined;
}

export async function storeSet<T>(key: string, value: T): Promise<void> {
  const s = await getStore();
  await s.set(key, value);
}

export async function storeDelete(key: string): Promise<void> {
  const s = await getStore();
  await s.delete(key);
}

/**
 * 一次性迁移：把老版本写在 webview localStorage 的同名键拿出来塞进 store，
 * 然后删除 localStorage 残留。已迁过的会跳过。
 */
export async function migrateFromLocalStorage(
  pairs: Array<{ lsKey: string; storeKey: string }>,
): Promise<void> {
  const s = await getStore();
  for (const { lsKey, storeKey } of pairs) {
    const existing = await s.get(storeKey);
    if (existing !== null && existing !== undefined) continue;
    const raw = localStorage.getItem(lsKey);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      await s.set(storeKey, parsed);
      localStorage.removeItem(lsKey);
      console.log(`[storage] migrated ${lsKey} → ${storeKey}`);
    } catch (err) {
      console.warn(`[storage] migrate ${lsKey} failed`, err);
    }
  }
}
