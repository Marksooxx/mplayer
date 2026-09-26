// mpv.ts 相对 seek 目标累计逻辑：模拟 IPC(拦截 Tauri invoke)，观察登记给时钟的目标
(globalThis as any).window = globalThis;
const calls: any[] = [];
(globalThis as any).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: any) => { calls.push([cmd, args]); return null; },
  transformCallback: () => 0,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
};
const store = await import(new URL("../../../src/store/playerStore.ts", import.meta.url).href);
const clockMod = await import(new URL("../../../src/hooks/useCursorAnimation.ts", import.meta.url).href);
const mpv = await import(new URL("../../../src/lib/mpv.ts", import.meta.url).href);

// 截获登记给时钟的目标：包一层 forceSnap
const targets: number[] = [];
const origDebug = clockMod.getPlayheadDebugInfo;
void origDebug;
const P = store.usePlayerStore;
let failures = 0;
const check = (name: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${d ? "  — " + d : ""}`); if (!ok) failures++; };

// 通过 seek 命令的参数间接验证：目标无法直接读取，改为读取 mpv.ts 导出的调试钩子
const hook = (mpv as any).lastSeekForDebug as (() => { target: number; at: number } | null) | undefined;
if (!hook) { console.log("NO_HOOK"); process.exit(2); }

function setPos(v: number) { P.setState({ position: v, positionObservedAt: performance.now() }); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

P.setState({ duration: 60, isPlaying: false, fileLoaded: true, speed: 1, playingSince: 0 });
setPos(10);
await sleep(5);
// 连按三次 +5，期间没有新回报
await mpv.seekRelative(5); targets.push(hook()!.target);
await mpv.seekRelative(5); targets.push(hook()!.target);
await mpv.seekRelative(5); targets.push(hook()!.target);
check("连按 3 次 +5（无回报）→ 15/20/25", JSON.stringify(targets) === "[15,20,25]", JSON.stringify(targets));

// 竞态：第一次的落点 15 在第二次之后才到 → 第三次仍以第二次目标累计
await sleep(5); setPos(40); await sleep(5);           // 先让链断开：回报到达 40(=上次目标附近? 否，重置)
P.setState({ position: 40, positionObservedAt: performance.now() });
await sleep(1600);                                    // 超过链窗口
const t: number[] = [];
await mpv.seekRelative(5); t.push(hook()!.target);   // 40+5
await mpv.seekRelative(5); t.push(hook()!.target);   // 50
await sleep(2); setPos(45);                           // 第一次的落点(45)晚到：不在第二次目标 50 附近
await mpv.seekRelative(5); t.push(hook()!.target);   // 应为 55
check("第一次落点在第二次之后到达 → 仍累计", JSON.stringify(t) === "[45,50,55]", JSON.stringify(t));

// 已落地后：以 mpv 当前位置为基准
await sleep(2); setPos(55); await sleep(50);
await mpv.seekRelative(5); const u = hook()!.target;
check("落地后按当前位置 55 → 60", u === 60, String(u));

// 越界钳制
setPos(58); await sleep(1600);
await mpv.seekRelative(5); const v = hook()!.target;
check("越界钳到 duration 60", v === 60, String(v));

// 刚恢复播放：外推起点不早于恢复时刻(codex 反例：暂停在 10s 很久，恢复后立刻 +5)
await sleep(1600);                                    // 让上一条链过期
P.setState({ isPlaying: false });
P.setState({ position: 10, positionObservedAt: performance.now() });
await sleep(2500);                                    // 长暂停，期间无回报
P.getState().setIsPlaying(true);                      // 恢复
await sleep(20);                                      // 立刻按键(还没有新的 time-pos)
await mpv.seekRelative(5); const w = hook()!.target;
check("长暂停后立即 +5：外推不含暂停时长(≈15.02)", Math.abs(w - 15.02) < 0.02, `target=${w.toFixed(3)}`);

console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
