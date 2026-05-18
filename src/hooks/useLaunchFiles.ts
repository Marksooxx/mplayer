import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePlayerStore } from "../store/playerStore";
import { playIndex } from "./useMpv";

/**
 * 处理 Windows 关联/拖拽到 exe 启动场景：
 *  - 进程首次启动：拉一次 get_launch_args 拿到 argv 里的文件路径
 *  - 已运行实例被再次启动（single-instance 转发）：监听 "open-files" 事件
 * 都做：appendToPlaylist + 自动播放新加的第一个。
 */
export function useLaunchFiles(): void {
  useEffect(() => {
    const enqueue = (paths: string[]) => {
      if (!paths || paths.length === 0) return;
      const s = usePlayerStore.getState();
      const startEmpty = s.playlist.length === 0;
      const added = s.appendToPlaylist(paths);
      if (added.length === 0) return;
      const target = startEmpty ? 0 : s.playlist.length; // 新加的第一个
      void playIndex(target);
    };

    // 首次启动 args
    void invoke<string[]>("get_launch_args")
      .then((args) => {
        if (args && args.length > 0) {
          console.log("[launch] initial files:", args);
          enqueue(args);
        }
      })
      .catch((err) => console.warn("[launch] get_launch_args failed", err));

    // single-instance 二次启动转发
    let unlisten: (() => void) | undefined;
    void listen<string[]>("open-files", (e) => {
      console.log("[launch] open-files event:", e.payload);
      enqueue(e.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);
}
