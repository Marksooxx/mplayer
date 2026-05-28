import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlayerStore } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { playIndex } from "../hooks/useMpv";
import {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  firstSupportedIndex,
} from "../lib/media-types";

const TRIGGER_HEIGHT = 60; // 鼠标进入顶部 60px 范围内触发显示
const HIDE_DELAY = 2500; // 离开后 2.5 秒淡出

interface Props {
  /** 全屏时由 App 的 useFullscreenReveal 决定 TopBar 的可见性。
      非全屏时此值始终 true,TopBar 自己内部 autoHide/hidden 逻辑决定。 */
  fullscreenTopVisible?: boolean;
}

export function TopBar({ fullscreenTopVisible = true }: Props) {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const appendToPlaylist = usePlayerStore((s) => s.appendToPlaylist);

  const autoHide = useSettingsStore((s) => s.topBarAutoHide);
  const hidden = useSettingsStore((s) => s.topBarHidden);

  const [visible, setVisible] = useState(true);
  const [initialReveal, setInitialReveal] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const scheduleHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_DELAY);
  };

  // 启动时短暂显示一次，然后自动隐藏
  useEffect(() => {
    if (hidden) {
      setVisible(false);
      return;
    }
    if (!autoHide) {
      setVisible(true);
      setInitialReveal(false);
      return;
    }
    setInitialReveal(true);
    setVisible(true);
    const t = setTimeout(() => {
      setInitialReveal(false);
      setVisible(false);
    }, HIDE_DELAY);
    return () => clearTimeout(t);
  }, [autoHide, hidden]);

  // 鼠标在窗口顶部范围内时显示
  useEffect(() => {
    if (hidden) return;
    if (!autoHide) return;

    const onMove = (e: MouseEvent) => {
      const overBar = barRef.current && e.target instanceof Node && barRef.current.contains(e.target);
      if (e.clientY <= TRIGGER_HEIGHT || overBar) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        setVisible(true);
      } else if (visible && !initialReveal) {
        scheduleHide();
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [autoHide, hidden, visible, initialReveal]);

  const handleOpen = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        { name: "媒体文件", extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
        { name: "视频", extensions: VIDEO_EXTENSIONS },
        { name: "音频", extensions: AUDIO_EXTENSIONS },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    const startEmpty = playlist.length === 0;
    const added = appendToPlaylist(paths);
    if (startEmpty && added.length > 0) {
      const idx = firstSupportedIndex(added);
      if (idx >= 0) void playIndex(idx);
    }
  };

  if (hidden) return null;

  const current = currentIndex >= 0 ? playlist[currentIndex] : null;
  // 全屏:由外部 fullscreenTopVisible 控制(鼠标到顶部 80px 内才显示)
  // 非全屏:跟设置的 autoHide 走;关掉 autoHide 一直显示
  const show = fullscreen ? fullscreenTopVisible : !autoHide || visible;

  return (
    <div
      ref={barRef}
      className="absolute top-0 left-0 right-0 flex items-center gap-3 px-4 py-2 bg-gradient-to-b from-black/85 to-black/30 transition-opacity"
      style={{
        zIndex: 30,
        opacity: show ? 1 : 0,
        // 外层不拦截点击，让非按钮区域的单击/双击透传给 PlayerView
        pointerEvents: "none",
        transitionDuration: "300ms",
      }}
    >
      <button
        type="button"
        onClick={handleOpen}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary-500 hover:bg-primary-400 text-white text-sm transition-colors shadow"
        style={{ pointerEvents: show ? "auto" : "none" }}
      >
        <FolderOpen size={15} />
        打开文件
      </button>
      <div className="flex-1 min-w-0 text-sm text-white/85 truncate drop-shadow">
        {current ? current.name : "未加载文件 — 点击「打开文件」或拖入文件"}
      </div>
      <div className="text-xs text-white/55 tabular-nums shrink-0 drop-shadow">
        {playlist.length > 0 ? `${currentIndex + 1} / ${playlist.length}` : ""}
      </div>
    </div>
  );
}
