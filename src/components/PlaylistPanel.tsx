import { useRef, useState } from "react";
import { FolderOpen, ListMusic, Save } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { usePlayerStore } from "../store/playerStore";
import {
  PLAYLIST_WIDTH_MAX,
  PLAYLIST_WIDTH_MIN,
  useSettingsStore,
} from "../store/settingsStore";
import { PlaylistItem } from "./PlaylistItem";
import { exportToM3U8, parseM3U } from "../lib/playlist-io";
import { playIndex } from "../hooks/useMpv";

const PLAYLIST_FILTERS = [{ name: "M3U 播放列表", extensions: ["m3u8", "m3u"] }];

export function PlaylistPanel() {
  const playlist = usePlayerStore((s) => s.playlist);
  const collapsed = useSettingsStore((s) => s.playlistCollapsed);
  const width = useSettingsStore((s) => s.playlistWidth);
  const setWidth = useSettingsStore((s) => s.setPlaylistWidth);
  const appendToPlaylist = usePlayerStore((s) => s.appendToPlaylist);
  const setPlaylist = usePlayerStore((s) => s.setPlaylist);

  const [resizing, setResizing] = useState(false);
  const resizeRafRef = useRef<number | null>(null);

  if (collapsed) return null;

  // 拖动左边缘改变 playlist 宽度（向左拉变宽，向右收缩；range 200–600）。
  // rAF 节流避免 60+Hz 触发的 React render 风暴。
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = width;
    setResizing(true);
    document.body.style.cursor = "col-resize";

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // 鼠标左移 → delta 正 → 宽度增大
      const target = startWidth + delta;
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null;
        setWidth(target);
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
      setResizing(false);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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
      className="relative flex flex-col h-full border-l border-white/10 bg-neutral-950 anim-slide-right"
      style={{ width, zIndex: 20 }}
    >
      {/* 左边缘拖动条 —— 宽 5px，hover/active 时高亮 primary；占用 z-index 30 避免被列表盖住 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整播放列表宽度"
        title={`拖动调整宽度（${PLAYLIST_WIDTH_MIN}-${PLAYLIST_WIDTH_MAX}px）`}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => setWidth(280)}
        className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-30 transition-colors ${
          resizing
            ? "bg-primary-500/60"
            : "bg-transparent hover:bg-primary-400/30"
        }`}
        style={{ marginLeft: -2 }} /* 让点击区域跨过左边框，更好命中 */
      />
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
