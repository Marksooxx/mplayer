import { FolderOpen, ListMusic, Save } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { PlaylistItem } from "./PlaylistItem";
import { exportToM3U8, parseM3U } from "../lib/playlist-io";
import { playIndex } from "../hooks/useMpv";

const PLAYLIST_FILTERS = [{ name: "M3U 播放列表", extensions: ["m3u8", "m3u"] }];

export function PlaylistPanel() {
  const playlist = usePlayerStore((s) => s.playlist);
  const collapsed = useSettingsStore((s) => s.playlistCollapsed);
  const appendToPlaylist = usePlayerStore((s) => s.appendToPlaylist);
  const setPlaylist = usePlayerStore((s) => s.setPlaylist);

  if (collapsed) return null;

  const handleSave = async () => {
    if (playlist.length === 0) return;
    const target = await save({
      defaultPath: "playlist.m3u8",
      filters: PLAYLIST_FILTERS,
    });
    if (!target) return;
    const m3u = exportToM3U8(playlist.map((it) => it.path));
    try {
      await writeTextFile(target, m3u);
    } catch (err) {
      console.error("[playlist] save failed", err);
      usePlayerStore.getState().setError(
        "保存播放列表失败：" + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const handleLoad = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: PLAYLIST_FILTERS,
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const text = await readTextFile(selected);
      const paths = parseM3U(text);
      if (paths.length === 0) return;
      // 替换当前列表
      setPlaylist([]);
      const added = appendToPlaylist(paths);
      if (added.length > 0) void playIndex(0);
    } catch (err) {
      console.error("[playlist] load failed", err);
      usePlayerStore.getState().setError(
        "加载播放列表失败：" + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  return (
    <aside
      className="flex flex-col h-full border-l border-white/10 bg-neutral-950"
      style={{ width: 280, zIndex: 20 }}
    >
      <div className="flex items-center gap-1 px-3 py-2.5 border-b border-white/10">
        <ListMusic size={16} className="text-white/70" />
        <span className="flex-1 text-sm font-medium text-white/90">播放列表</span>
        <span className="text-xs text-white/40 mr-1">{playlist.length}</span>
        <button
          type="button"
          onClick={handleLoad}
          title="加载 .m3u/.m3u8 播放列表"
          className="w-7 h-7 inline-flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/10"
        >
          <FolderOpen size={14} />
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={playlist.length === 0}
          title="保存当前播放列表为 .m3u8"
          className="w-7 h-7 inline-flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <Save size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {playlist.length === 0 ? (
          <div className="px-3 py-6 text-xs text-white/40 text-center leading-relaxed">
            列表为空<br />
            通过顶部按钮、拖入文件，或上方📂 加载 .m3u8 添加
          </div>
        ) : (
          playlist.map((item, idx) => (
            <PlaylistItem key={item.id} item={item} index={idx} />
          ))
        )}
      </div>
    </aside>
  );
}
