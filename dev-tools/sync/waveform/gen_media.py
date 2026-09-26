"""生成波形对拍用的 PCM 大素材（每个约 0.5MB，不入库）到 media/generated/。

所有素材的内容都一样：3.000s 静音 + 1.000s 与 2.500s 处各一个 4ms、0.8 幅度的
1kHz 脉冲；差别只在编码 / 容器 / 起点偏移。其余小素材（压缩格式、手工构造的
畸形样本）直接放在 media/ 里入库。

用法：python dev-tools/sync/waveform/gen_media.py   （需要 PATH 上有 ffmpeg）
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "media", "generated")

PULSES = "aevalsrc='0.8*sin(2*PI*1000*t)*(between(t,1.0,1.004)+between(t,2.5,2.504))':s=48000:d=3"
VIDEO = "color=c=black:s=320x240:r={fps}:d={dur}"


def ff(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    ref48 = os.path.join(OUT, "ref48.wav")
    ff("-f", "lavfi", "-i", PULSES, "-ac", "2", "-c:a", "pcm_s16le", ref48)
    ff("-i", ref48, "-ar", "44100", "-c:a", "pcm_s16le", os.path.join(OUT, "ref44.wav"))
    ff("-i", ref48, "-ac", "1", "-c:a", "pcm_s24le", os.path.join(OUT, "mono24.wav"))
    # 视频 3.5s、音频 3.0s：波形右侧应留空、不得拉伸
    ff("-f", "lavfi", "-i", VIDEO.format(fps=30, dur=3.5), "-i", ref48,
       "-c:v", "libx264", "-c:a", "pcm_s16le", os.path.join(OUT, "v_pcm_longvideo.mov"))
    # 音轨晚于视频起播（MP4/MOV 写成 elst 空编辑，MKV 写成首块时间戳）
    for name, off in (("delay_pcm.mov", "0.5"), ("voff_pcm.mov", "0.2"), ("voff_pcm.mkv", "0.2")):
        ff("-f", "lavfi", "-i", VIDEO.format(fps=25, dur=3.52), "-itsoffset", off, "-i", ref48,
           "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-c:a", "pcm_s16le", os.path.join(OUT, name))
    print("generated ->", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
