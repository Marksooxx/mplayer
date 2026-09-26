"""波形时间轴对拍：跑 Rust 的 peaks 对拍测试，与 expected.json 里的 mpv 实播真值比较。

用法：python dev-tools/sync/waveform/check_timing.py
- 缺 media/generated/ 时先调 gen_media.py 生成（需要 ffmpeg）
- 按 audioIndex 分组，每组把素材复制到临时目录后跑一次
  `cargo test --lib print_timeline -- --ignored --nocapture`
- 退出码 0 = 全部通过
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(HERE, "media")
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
TAURI = os.path.join(REPO, "src-tauri")
LINE = re.compile(r"^TIMING (\S+) (.*)$")


def run_group(files, audio_index):
    tmp = tempfile.mkdtemp(prefix="mplayer-timing-")
    try:
        for rel in files:
            shutil.copy(os.path.join(MEDIA, rel), os.path.join(tmp, os.path.basename(rel)))
        env = dict(os.environ, MPLAYER_TIMING_MEDIA=tmp)
        if audio_index is not None:
            env["MPLAYER_TIMING_AUDIO_INDEX"] = str(audio_index)
        out = subprocess.run(
            ["cargo", "test", "--lib", "print_timeline", "--", "--ignored", "--nocapture"],
            cwd=TAURI, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        got = {}
        for line in (out.stdout + out.stderr).splitlines():
            m = LINE.match(line.strip())
            if not m:
                continue
            name, rest = m.groups()
            if " ERR " in f" {rest}" or rest.startswith("ERR") or "PANIC" in rest:
                got[name] = "error"
            else:
                on = re.search(r"onsets=\[([^\]]*)\]", rest)
                got[name] = [float(x) for x in on.group(1).split(",") if x.strip()] if on else []
        return got
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    if not os.path.isdir(os.path.join(MEDIA, "generated")):
        subprocess.run([sys.executable, os.path.join(HERE, "gen_media.py")], check=True)
    cases = json.load(open(os.path.join(HERE, "expected.json"), encoding="utf-8"))["cases"]
    groups = {}
    for c in cases:
        groups.setdefault(c.get("audioIndex"), set()).add(c["file"])
    results = {k: run_group(sorted(v), k) for k, v in groups.items()}

    fails = 0
    for c in cases:
        idx = c.get("audioIndex")
        name = os.path.basename(c["file"])
        got = results[idx].get(name)
        tol = c.get("tol_ms", 1.0) / 1000
        label = f"{c['file']}" + (f" [音轨{idx + 1}]" if idx is not None else "")
        if c["expect"] == "error":
            ok = got == "error"
            detail = "报不可用" if ok else f"期望不可用，实际 {got}"
        elif not isinstance(got, list):
            ok, detail = False, f"实际 {got}"
        else:
            exp = c["expect"]
            ok = len(got) == len(exp) and all(abs(g - e) <= tol for g, e in zip(got, exp))
            diffs = ", ".join(f"{(g - e) * 1000:+.2f}" for g, e in zip(got, exp))
            detail = f"Δ=[{diffs}]ms (容差 {tol * 1000:g}ms)" + ("" if len(got) == len(exp) else f" 数量 {len(got)}≠{len(exp)}")
        print(f"{'PASS' if ok else 'FAIL'}  {label:36} {detail}")
        fails += 0 if ok else 1
    print(f"\n{len(cases) - fails}/{len(cases)} 通过")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
