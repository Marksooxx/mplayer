// 波形 / 播放头同步的全部离线测试。用法：
//   pnpm test:sync            全部（含 Rust 解码对拍，需要 cargo + ffmpeg，首次较慢）
//   pnpm test:sync --quick    跳过 Rust 对拍
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const quick = process.argv.includes("--quick");
const node = [process.execPath, "--experimental-strip-types", "--no-warnings"];

const steps = [
  ["时钟 · 合成边界用例", [...node, "dev-tools/sync/clock/edge.test.ts"]],
  ["时钟 · 真实 mpv 事件回放", [...node, "dev-tools/sync/clock/replay.test.ts"]],
  ["时钟 · 用户操作录制回放", [...node, "dev-tools/sync/clock/steps.test.ts"]],
  ["时钟 · 相对 seek 目标累计（tsx）", ["npx", "-y", "tsx", "dev-tools/sync/clock/seek-chain.test.mts"]],
  ["波形 · 时间轴重采样", [...node, "dev-tools/sync/waveform/timeline.test.ts"]],
];
if (!quick) steps.push(["波形 · Rust 解码对拍 mpv", ["python", "dev-tools/sync/waveform/check_timing.py"]]);

const results = [];
for (const [name, [cmd, ...args]] of steps) {
  console.log(`\n━━ ${name}`);
  const r = spawnSync(cmd, args, { cwd: repo, stdio: "inherit", shell: process.platform === "win32" && cmd !== process.execPath });
  results.push([name, r.status === 0]);
}
console.log("\n━━ 汇总");
for (const [name, ok] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
