import { useEffect, useRef, useState } from "react";
import {
  ArrowDownAZ,
  ArrowDownUp,
  ArrowUpAZ,
  FolderOpen,
  FolderTree,
  ListOrdered,
  Save,
  Trash2,
} from "lucide-react";
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

  // Delete 键删除选中项(desktop 习惯):
  // - 在 INPUT/TEXTAREA 内不处理(编辑文本时按 Delete 应删字符)
  // - selectedIndex < 0 (无选中) 也不处理
  // - 不依赖 settings.shortcuts 配置,这是 playlist 上下文相关固定键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete") return;
      const t = e.target;
      if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return;
      }
      const s = usePlayerStore.getState();
      if (s.selectedIndex < 0) return;
      const item = s.playlist[s.selectedIndex];
      if (item) {
        e.preventDefault();
        s.removeFromPlaylist(item.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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

  // 排序操作:按 mode 重排 playlist 数组,然后用 item.id 找回 currentIndex,
  // 避免打断当前播放。localeCompare numeric 让 "video2" < "video10"。
  // "default" 按 item.seq(添加时分配的单调递增序号)升序——永远可以回到原始
  // 添加顺序,即使用户已经多次排序/手动调整过。
  type SortMode = "default" | "name-asc" | "name-desc" | "path-asc";
  const [sortOpen, setSortOpen] = useState(false);
  const handleSort = (mode: SortMode) => {
    setSortOpen(false);
    const s = usePlayerStore.getState();
    if (s.playlist.length <= 1) return;
    const currentId = s.currentIndex >= 0 ? s.playlist[s.currentIndex]?.id : null;
    const list = [...s.playlist];
    const cmpOpts = { numeric: true, sensitivity: "base" as const };
    switch (mode) {
      case "default":
        list.sort((a, b) => a.seq - b.seq);
        break;
      case "name-asc":
        list.sort((a, b) => a.name.localeCompare(b.name, "zh", cmpOpts));
        break;
      case "name-desc":
        list.sort((a, b) => b.name.localeCompare(a.name, "zh", cmpOpts));
        break;
      case "path-asc":
        list.sort((a, b) => a.path.localeCompare(b.path, "zh", cmpOpts));
        break;
    }
    s.setPlaylist(list);
    // 把 currentIndex 指回当前播放的同一 item(它现在在新位置)
    if (currentId !== null) {
      const newIdx = list.findIndex((it) => it.id === currentId);
      if (newIdx >= 0) s.setCurrentIndex(newIdx);
    }
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
        // 合成层 hint，提高 144Hz 屏上滑入滑出的丝滑度
        willChange: "transform",
        // 注:之前加过 contain: layout paint,但 contain: paint 会让 aside 成为
        // fixed 定位子元素的 containing block。结果 PlaylistItem 的右键 menu
        // (position: fixed + left: e.clientX 相对 viewport) 被解释为相对 aside,
        // menu 跑到屏外/被 paint 裁切完全不可见,表现为"右键没反应"。已移除。
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
        <div className="relative">
          <button
            type="button"
            onClick={() => setSortOpen((v) => !v)}
            disabled={playlist.length <= 1}
            title="排序"
            className="w-7 h-7 inline-flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <ArrowDownUp size={14} />
          </button>
          {sortOpen && (
            <>
              {/* 透明 backdrop 点击关闭 */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setSortOpen(false)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSortOpen(false);
                }}
              />
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] py-1 rounded-md border border-white/10 bg-neutral-900 shadow-xl text-sm text-white/90 select-none">
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2"
                  onClick={() => handleSort("default")}
                  title="按添加顺序还原（永远可回到此状态）"
                >
                  <ListOrdered size={14} /> 默认（添加顺序）
                </button>
                <div className="my-1 border-t border-white/10" />
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2"
                  onClick={() => handleSort("name-asc")}
                >
                  <ArrowDownAZ size={14} /> 按名称 A → Z
                </button>
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2"
                  onClick={() => handleSort("name-desc")}
                >
                  <ArrowUpAZ size={14} /> 按名称 Z → A
                </button>
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2"
                  onClick={() => handleSort("path-asc")}
                >
                  <FolderTree size={14} /> 按路径分组
                </button>
              </div>
            </>
          )}
        </div>
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
