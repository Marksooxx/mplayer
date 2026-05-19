import { useRef, useState } from "react";
import { FolderOpen, Save, Trash2 } from "lucide-react";
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
import { stopPlayback } from "../lib/mpv";

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

  // ★ 不再 conditional return null ★
  // 之前 collapsed 时 unmount，配合 mpv setVideoMarginRatio 异步 IPC，会有
  // 80-200ms 的"DOM 缺席瞬态"——那 280px 区域无不透明 DOM、mpv 还没绘制 →
  // Tauri 透明窗口穿透到桌面 → 用户看到"白色漏光"。
  // 改为始终挂载 + transform: translateX(width) 滑出右屏外。DOM 永远占住那
  // 280px 不透明黑底，mpv margin 怎么切都不会露底。打开/关闭通过 CSS
  // transform transition 滑入滑出，零 layout/paint，纯合成器动画。

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

  const handleClear = async () => {
    if (playlist.length === 0) return;
    try {
      await stopPlayback();
    } catch {
      /* ignore — 仍要清空列表 */
    }
    setPlaylist([]);
  };

  return (
    <aside
      className="absolute right-0 top-0 bottom-0 flex flex-col border-l border-white/10 bg-neutral-950"
      style={{
        width,
        // collapsed: 滑到右屏外（translateX 等于自身宽度），可见时停在 right:0
        transform: collapsed ? `translateX(${width}px)` : "translateX(0)",
        // resizing 时关闭 transition，避免拖动改变 width 跟 transform 联动卡顿
        transition: resizing ? "none" : "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)",
        zIndex: 20,
        // 关掉合成时的 hint，提高 144Hz 屏上的丝滑度
        willChange: "transform",
        // 容器隔离：自己的 layout/paint 不波及外层（光标 rAF 高频写 DOM 时受益）
        contain: "layout paint",
      }}
      aria-hidden={collapsed}
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
      {/* 标题栏简化:去掉"播放列表"长文字(用户已知所在区域),只保留紧凑的
          数量提示 + 三个操作按钮。280px panel 下不再挤,且数字不再跟保存
          图标视觉粘连。详见 image #12 用户反馈。 */}
      <div className="flex items-center gap-0.5 px-2 py-2 border-b border-white/10">
        <span className="flex-1 text-xs text-white/50 tabular-nums pl-1.5 select-none">
          {playlist.length === 0 ? "空列表" : `${playlist.length} 项`}
        </span>
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
        <button
          type="button"
          onClick={handleClear}
          disabled={playlist.length === 0}
          title="清空播放列表"
          className="w-7 h-7 inline-flex items-center justify-center rounded text-white/55 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-white/55"
        >
          <Trash2 size={14} />
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
