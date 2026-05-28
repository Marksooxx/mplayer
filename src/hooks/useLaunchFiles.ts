import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePlayerStore } from "../store/playerStore";
import { playIndex } from "./useMpv";
import { firstSupportedIndex } from "../lib/media-types";

/**
 * 处理 Windows 关联/拖拽到 exe 启动场景:
 *  - 进程首次启动:拉一次 get_launch_args 拿到 argv 里的文件路径
 *  - 已运行实例被再次启动(single-instance 转发):监听 "open-files" 事件
 *
 * ★ "立即播放新文件"语义(像 VLC 一样)★
 *
 * Windows 多选 N 个文件按回车,Shell 会启动 N 次 .exe(每次 ProgID 命令
 * "%1" 接一个文件),全被 single-instance 转发到主实例。
 *
 * ★ 两个 race 都要处理 ★
 *
 * 1. **主实例启动期间的 emit 丢失**:第一个进程成为主实例还在初始化
 *    React 时,后续 N-1 个进程立即 emit "open-files",主实例 listener
 *    还没挂上 → 事件丢失。
 *    → Rust 端 single-instance handler 同时把 paths append 到 LaunchArgs
 *      state;本 hook invoke get_launch_args 时一并取走兜底。
 *
 * 2. **listen 与 invoke 之间的 race**:listen 挂上之后但 invoke 之前的
 *    转发,既被 listen 接到(通过事件)又被 invoke 取走(从 state)→ 重复。
 *    → 用 Set buffer 自动去重。同一路径 150ms buffer 内只算一次。
 *
 * 3. **多选 N 个文件需要合并 playlist**:N 个进程在 < 150ms 内各 emit/append
 *    一次,Set buffer 合并 → flush 时一次性 replace + add N 项。
 */
export function useLaunchFiles(): void {
  useEffect(() => {
    const buffer = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const flush = () => {
      timer = null;
      if (buffer.size === 0) return;
      const paths = [...buffer];
      buffer.clear();
      const s = usePlayerStore.getState();
      // "立即播放"语义:清空旧列表,加入新文件,播第一个可播放项。
      // 不支持的文件(非视频/音频)照样进列表,只是被跳过不自动播放,
      // PlaylistItem 标「不支持」展示。
      s.setPlaylist([]);
      const added = s.appendToPlaylist(paths);
      const idx = firstSupportedIndex(added);
      if (idx >= 0) void playIndex(idx);
    };

    const enqueue = (paths: string[]) => {
      if (!paths || paths.length === 0) return;
      for (const p of paths) buffer.add(p);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 150);
    };

    void (async () => {
      // 1. 先 await listen 挂上 listener,缩小"emit 丢失"窗口
      try {
        unlisten = await listen<string[]>("open-files", (e) => {
          console.log("[launch] open-files event:", e.payload);
          enqueue(e.payload);
        });
        if (cancelled) {
          unlisten?.();
          return;
        }
      } catch (err) {
        console.warn("[launch] listen failed", err);
      }
      // 2. 然后 invoke 取走 LaunchArgs state(initial args + 主实例启动期间
      //    single-instance 转发累积的 paths)。Set 去重确保 listen 已接到
      //    的同一路径不会被重复加。
      try {
        const args = await invoke<string[]>("get_launch_args");
        if (cancelled) return;
        if (args && args.length > 0) {
          console.log("[launch] initial files:", args);
          enqueue(args);
        }
      } catch (err) {
        console.warn("[launch] get_launch_args failed", err);
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, []);
}
