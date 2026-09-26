"""App 端到端：打开 / 切换视频后头 2.5s 光标是否倒退(§6.35 起播停顿)。

无参数启动 debug 构建(WebView2 远程调试端口)，CDP 注入逐帧采样器记录时间码 OSD(= 虚拟播放头)，
再用第二个进程把视频转交给它(单实例 open-files，与双击打开同一路径)，随后切到另一个视频。
统计每次加载后 2.5s 内的倒退(相邻采样变小 >1ms)次数与最大幅度。测试前后备份 / 还原 store.json。

用法(需先 pnpm tauri build --debug --no-bundle；App 不能已在运行)：
  uv run --with websocket-client --with numpy python dev-tools/sync/probes/app_startup_e2e.py [--runs 5] [--exe …]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app_pause_e2e as E  # noqa: E402  复用窗口 / CDP / 视频生成

SAMPLER = """(() => { window.__osd = []; const f = () => {
  const d = document.querySelector('div.fixed.top-12.left-3'); const s = d && d.querySelector('span');
  window.__osd.push([performance.now(), s ? s.textContent : null]); requestAnimationFrame(f); };
  requestAnimationFrame(f); return 'ok'; })()"""


def osd_s(t):
    return None if t is None else E.osd_seconds(t)


def analyze(samples, t_from):
    """t_from(performance.now) 之后 2.5s 内、新文件回到开头(<0.3s)之后：倒退次数、各次幅度(ms)与时刻"""
    seq = [(t, osd_s(v)) for t, v in samples if t >= t_from and t < t_from + 2500 and v is not None]
    k = next((i for i, (_, v) in enumerate(seq) if v < 0.3), len(seq))
    seq = seq[k:]
    backs = [(round((a[1] - b[1]) * 1000, 1), round(b[0] - t_from)) for a, b in zip(seq, seq[1:]) if b[1] < a[1] - 0.001]
    return {"n": len(seq), "backs": len(backs), "max_back_ms": max([x[0] for x in backs], default=0), "detail": backs[:4]}


def main():
    repo = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", default=os.path.join(repo, "src-tauri", "target", "debug", "mplayer.exe"))
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--work", default=os.path.join(tempfile.gettempdir(), "mplayer-pause-e2e"))
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    v1 = os.path.join(a.work, "app_frames24.mp4")
    if not os.path.exists(v1):
        E.gen_video(v1)
    v2 = os.path.join(a.work, "app_frames24_b.mp4")
    if not os.path.exists(v2):
        shutil.copy2(v1, v2)
    store = os.path.expandvars(r"%APPDATA%\dev.mark.mplayer\store.json")
    backup = os.path.join(a.work, "store.json.startup.bak")
    shutil.copy2(store, backup)
    results = []
    try:
        for r in range(a.runs):
            env = dict(os.environ, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333")
            p = subprocess.Popen([a.exe], env=env)
            try:
                cdp = E.Cdp(9333)
                time.sleep(2.0)
                cdp.js(SAMPLER)
                ui = json.load(open(store, encoding="utf-8")).get("ui", {})
                if not ui.get("showTimecodeOsd"):
                    cdp.key("t", "KeyT", 84)  # 加载前打开时间码 OSD(设置在结束时还原)
                    time.sleep(0.2)
                row = {}
                for label, vid in (("打开", v1), ("切换", v2)):
                    t0 = cdp.js("performance.now()")
                    subprocess.run([a.exe, vid], env=os.environ)  # 单实例转发 open-files
                    time.sleep(3.0)
                    row[label] = analyze(cdp.js("window.__osd"), t0)
                results.append(row)
                print(f"#{r + 1} 打开 {row['打开']}  切换 {row['切换']}", flush=True)
            finally:
                for h in E.windows_of(p.pid):
                    E.user32.PostMessageW(h, 0x0010, None, None)
                try:
                    p.wait(timeout=8)
                except Exception:
                    subprocess.run([os.path.join(os.environ["SystemRoot"], "System32", "taskkill.exe"), "/PID", str(p.pid), "/T", "/F"], capture_output=True)
                time.sleep(1.0)
    finally:
        shutil.copy2(backup, store)
        print("store.json 已还原")
    tot = [x for row in results for x in row.values()]
    bad = [x for x in tot if x["backs"]]
    print(f"\n{len(tot)} 次加载：出现倒退 {len(bad)} 次，最大倒退 {max([x['max_back_ms'] for x in tot], default=0)}ms")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
