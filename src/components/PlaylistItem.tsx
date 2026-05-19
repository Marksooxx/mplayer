import { useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpToLine, FolderOpen, Play, Trash2 } from "lucide-react";
import { MarqueeText } from "./MarqueeText";
import { usePlayerStore, type PlaylistItem as PlaylistItemType } from "../store/playerStore";
import { playIndex } from "../hooks/useMpv";
import { stopPlayback } from "../lib/mpv";
import { parentDir } from "../lib/format";

interface Props {
  item: PlaylistItemType;
  index: number;
}

export function PlaylistItem({ item, index }: Props) {
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const selectedIndex = usePlayerStore((s) => s.selectedIndex);
  const setSelectedIndex = usePlayerStore((s) => s.setSelectedIndex);
  const removeFromPlaylist = usePlayerStore((s) => s.removeFromPlaylist);
  const moveToTop = usePlayerStore((s) => s.moveToTop);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const isCurrent = currentIndex === index;
  const isSelected = selectedIndex === index;

  const handleClick = () => setSelectedIndex(index);
  const handleDoubleClick = () => {
    void playIndex(index);
  };
  const handleContext = (e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedIndex(index);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const closeMenu = () => setMenu(null);

  const openInFolder = async () => {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(item.path);
    } catch (err) {
      console.error("revealItemInDir failed", err);
    }
    closeMenu();
  };

  const handleRemove = () => {
    // 删的是当前正在播放的 item → 先 stop mpv,避免它继续解码已被列表移除的文件
    if (isCurrent) {
      void stopPlayback();
    }
    removeFromPlaylist(item.id);
    closeMenu();
  };
  const handleMoveTop = () => {
    moveToTop(item.id);
    closeMenu();
  };

  const bgClass = isCurrent
    ? "bg-primary-500/30 border-l-2 border-primary-400"
    : isSelected
      ? "bg-white/10"
      : "hover:bg-white/5";

  return (
    <>
      <div
        className={`group flex flex-col gap-0.5 px-3 py-2 cursor-pointer transition-colors ${bgClass}`}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContext}
        title={item.path}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`shrink-0 w-5 flex items-center justify-center text-xs ${
              isCurrent ? "text-primary-300" : "text-white/40"
            }`}
          >
            {isCurrent ? <Play size={12} fill="currentColor" /> : index + 1}
          </span>
          <div className="flex-1 min-w-0 text-sm text-white/90">
            <MarqueeText text={item.name} />
          </div>
        </div>
        <div className="pl-6 text-[10px] text-white/30 truncate">{parentDir(item.path)}</div>
      </div>
      {/* Portal 到 document.body —— PlaylistPanel 有 transform: translateX,
          fixed 后代会以 panel 为 containing block 而不是 viewport。Portal 把
          menu 渲染到 body 外面跳出这个影响,fixed 才能真正相对 viewport 定位。 */}
      {menu && createPortal(
        <>
          <div
            className="fixed inset-0 z-[120]"
            onClick={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
          />
          <div
            className="fixed z-[121] min-w-[180px] py-1 rounded-md border border-white/10 bg-neutral-900 shadow-xl text-sm text-white/90"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2"
              onClick={handleMoveTop}
            >
              <ArrowUpToLine size={14} /> 移到顶部
            </button>
            <button
              className="w-full px-3 py-1.5 text-left hover:bg-white/10 flex items-center gap-2"
              onClick={openInFolder}
            >
              <FolderOpen size={14} /> 在文件夹中显示
            </button>
            <button
              className="w-full px-3 py-1.5 text-left hover:bg-red-500/30 text-red-300 flex items-center gap-2"
              onClick={handleRemove}
            >
              <Trash2 size={14} /> 从列表移除
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
