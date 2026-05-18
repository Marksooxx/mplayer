/**
 * M3U / M3U8 播放列表的导入导出。兼容 VLC / mpv / Potplayer 等主流播放器。
 * 不支持 #EXT-X-STREAM-INF 等 HLS 流式扩展（不在我们用例内）。
 */

import { basename } from "./format";

/**
 * 导出为 M3U8 字符串。
 * 输出格式：
 *   #EXTM3U
 *   #EXTINF:-1,<filename>
 *   <absolute path>
 *   ...
 */
export function exportToM3U8(paths: string[]): string {
  const lines: string[] = ["#EXTM3U"];
  for (const p of paths) {
    lines.push(`#EXTINF:-1,${basename(p)}`);
    lines.push(p);
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * 解析 M3U / M3U8 文本，返回所有非注释行（认为是路径）。
 * BOM、空行、`#` 开头的注释 / 扩展都会被忽略。
 */
export function parseM3U(text: string): string[] {
  // 去掉 UTF-8 BOM
  const cleaned = text.replace(/^﻿/, "");
  const lines = cleaned.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}
