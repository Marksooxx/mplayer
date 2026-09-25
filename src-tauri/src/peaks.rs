use serde::Serialize;
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_MP3, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::media_timing::{self, Container};

fn app_error(code: &str, message: impl Into<String>) -> String {
    format!("[{}] {}", code, message.into())
}

/// 起始分辨率：每 16 帧一桶(48k 下 0.33ms)。短片段靠它把"桶起点偏早"压到亚毫秒。
const INITIAL_FRAMES_PER_PEAK: u32 = 16;
/// 桶数上限：到达后相邻两桶合并、每桶帧数翻倍。最终桶数落在 [CAP/2, CAP]，
/// 长文件的内存 / IPC 体积因此有上界(旧实现整文件样本常驻内存)。
const MAX_BUCKETS: usize = 16384;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeaksData {
    /// 每桶交替 [max, min]（跨声道），第 i 桶覆盖解码帧 [i·fpp, (i+1)·fpp)
    pub peaks: Vec<f32>,
    /// 每桶帧数(自适应，16 × 2^k)
    pub frames_per_peak: u32,
    /// 解码出的总帧数(最后一桶可能不满)
    pub total_frames: u64,
    /// 解码第 0 帧在 mpv 时间轴(time-pos)上的秒数。
    /// 负数 = 编码 priming 被 mpv 裁掉(AAC/LAME MP3)；正数 = 音轨晚于容器起点。
    /// 前端据此把 peaks 摆到真实时间上(§6.32)。
    pub start_time: f64,
    /// 解码时长(秒) = total_frames / sample_rate
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u32,
    /// 解码后样本的有效位数：PCM 系列（WAV/FLAC/ALAC/AIFF）填 16/24/32；
    /// lossy 编码（MP3/AAC/Opus/Vorbis）通常 None，前端识别为"lossy / 不适用"。
    pub bit_depth: Option<u32>,
    /// 整文件 L 声道绝对值峰值（0..~1, 浮点 PCM 偶尔 > 1）。
    /// 即使 mono 也填（== peak_overall），保持语义清晰。
    pub peak_l: f32,
    /// 整文件 R 声道绝对值峰值；mono 文件为 None。
    /// 用 Option 而非 f32::NAN：serde_json 默认不允许 NaN/Inf 序列化。
    pub peak_r: Option<f32>,
    /// 所有声道汇总最大绝对值峰值。
    pub peak_overall: f32,
}

/// 流式分桶器：边解码边聚合，不保留整文件样本。
struct Bucketer {
    frames_per_peak: u32,
    maxs: Vec<f32>,
    mins: Vec<f32>,
    cur_max: f32,
    cur_min: f32,
    cur_frames: u32,
    total_frames: u64,
}

impl Bucketer {
    fn new() -> Self {
        Self {
            frames_per_peak: INITIAL_FRAMES_PER_PEAK,
            maxs: Vec::new(),
            mins: Vec::new(),
            cur_max: f32::MIN,
            cur_min: f32::MAX,
            cur_frames: 0,
            total_frames: 0,
        }
    }

    fn push_frame(&mut self, max: f32, min: f32) {
        if max > self.cur_max {
            self.cur_max = max;
        }
        if min < self.cur_min {
            self.cur_min = min;
        }
        self.cur_frames += 1;
        self.total_frames += 1;
        if self.cur_frames == self.frames_per_peak {
            self.flush();
            if self.maxs.len() >= MAX_BUCKETS {
                self.halve();
            }
        }
    }

    fn flush(&mut self) {
        self.maxs.push(self.cur_max);
        self.mins.push(self.cur_min);
        self.cur_max = f32::MIN;
        self.cur_min = f32::MAX;
        self.cur_frames = 0;
    }

    /// 相邻两桶合并。只在整桶边界调用(MAX_BUCKETS 为偶数)，
    /// 合并后桶 i 仍从帧 i·fpp 开始，与后续新桶对齐。
    fn halve(&mut self) {
        let n = self.maxs.len() / 2;
        for i in 0..n {
            self.maxs[i] = self.maxs[2 * i].max(self.maxs[2 * i + 1]);
            self.mins[i] = self.mins[2 * i].min(self.mins[2 * i + 1]);
        }
        self.maxs.truncate(n);
        self.mins.truncate(n);
        self.frames_per_peak *= 2;
    }

    /// 补 n 帧静音(流内时间戳缺口)。整桶直接推，O(桶数) 而不是 O(帧数)。
    fn push_silence(&mut self, mut n: u64) {
        while n > 0 {
            if self.cur_frames == 0 && n >= self.frames_per_peak as u64 {
                self.cur_max = 0.0;
                self.cur_min = 0.0;
                self.cur_frames = self.frames_per_peak;
                self.total_frames += self.frames_per_peak as u64;
                n -= self.frames_per_peak as u64;
                self.flush();
                if self.maxs.len() >= MAX_BUCKETS {
                    self.halve();
                }
            } else {
                self.push_frame(0.0, 0.0);
                n -= 1;
            }
        }
    }

    fn finish(mut self) -> (Vec<f32>, u32, u64) {
        if self.cur_frames > 0 {
            self.flush();
        }
        let mut peaks = Vec::with_capacity(self.maxs.len() * 2);
        for (mx, mn) in self.maxs.iter().zip(self.mins.iter()) {
            peaks.push(*mx);
            peaks.push(*mn);
        }
        (peaks, self.frames_per_peak, self.total_frames)
    }
}

/// 流内时间戳缺口超过这么多才补静音(MKV 块时间戳只有 1ms 精度，不能太敏感)
const GAP_TOLERANCE_SECS: f64 = 0.010;
/// 单文件累计补静音上限(防御异常时间戳)
const MAX_GAP_FILL_SECS: f64 = 6.0 * 3600.0;

/// `audio_index`：mpv 当前 aid 在音轨中的序号(0 起)；None = 第一条音轨。
#[tauri::command]
pub async fn calculate_peaks(
    file_path: String,
    audio_index: Option<u32>,
) -> Result<PeaksData, String> {
    tauri::async_runtime::spawn_blocking(move || compute_peaks(&file_path, audio_index))
        .await
        .map_err(|e| app_error("E_PEAKS_TASK_JOIN", format!("join task failed: {}", e)))?
}

pub fn compute_peaks(file_path: &str, audio_index: Option<u32>) -> Result<PeaksData, String> {
    let file = File::open(file_path)
        .map_err(|e| app_error("E_PEAKS_OPEN_FILE", format!("open failed: {}", e)))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(file_path).extension() {
        hint.with_extension(ext.to_str().unwrap_or(""));
    }

    // 不开 enable_gapless：无 Xing/LAME 头的 MP3 在 gapless 模式下会按码率估算的帧数
    // 截尾(实测 -26ms)，而 mpv 不截。起点裁剪改由 start_time 表达(见 detect_start_time)。
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| app_error("E_PEAKS_PROBE", format!("probe failed: {}", e)))?;

    let mut format = probed.format;

    // —— 选轨：与 mpv 的 aid 对齐(第 N 条音轨，按容器顺序) ——
    let container = media_timing::sniff_container(file_path);
    let mkv = match container {
        Container::Matroska => media_timing::mkv_info(file_path),
        _ => None,
    };
    let audio_ids: Vec<u32> = match container {
        Container::Mp4 => media_timing::mp4_audio_traks(file_path).unwrap_or_default(),
        Container::Matroska => mkv
            .as_ref()
            .map(|m| {
                m.tracks
                    .iter()
                    .filter(|t| t.track_type == 2)
                    .map(|t| t.number as u32)
                    .collect()
            })
            .unwrap_or_default(),
        Container::Other => Vec::new(),
    };
    // 容器解析失败 / 其它容器：退回 symphonia 自己认得出的音轨
    let audio_ids = if audio_ids.is_empty() {
        format
            .tracks()
            .iter()
            .filter(|t| t.codec_params.sample_rate.is_some())
            .map(|t| t.id)
            .collect()
    } else {
        audio_ids
    };
    if audio_ids.is_empty() {
        return Err(app_error("E_PEAKS_TRACK", "no audio track in file"));
    }
    // 越界 = 前端的音轨序号与容器对不上：明确不可用，不拿第一条音轨冒充
    let want = audio_index.unwrap_or(0) as usize;
    let track_id = *audio_ids.get(want).ok_or_else(|| {
        app_error(
            "E_PEAKS_TRACK",
            format!("audio track #{} not found ({} audio tracks)", want + 1, audio_ids.len()),
        )
    })?;
    let audio_track = format
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .ok_or_else(|| app_error("E_PEAKS_TRACK", "selected audio track not found"))?;
    if audio_track.codec_params.codec == CODEC_TYPE_NULL {
        // mpv 正在播的这条音轨 symphonia 解不了(AC3/DTS/Opus…)：宁可明确不可用，
        // 也不拿另一条音轨的内容冒充
        return Err(app_error(
            "E_PEAKS_CODEC",
            "selected audio track codec is not supported by the waveform decoder",
        ));
    }

    let declared_rate = audio_track.codec_params.sample_rate.unwrap_or(44100);
    let channels = audio_track
        .codec_params
        .channels
        .map(|c| c.count() as u32)
        .unwrap_or(2)
        .max(1);
    // bits_per_sample 在 lossy 容器里通常是 None，前端按 null 处理
    let bit_depth = audio_track.codec_params.bits_per_sample;
    let codec_params = audio_track.codec_params.clone();
    let time_base = codec_params
        .time_base
        .filter(|tb| tb.denom > 0)
        .map(|tb| tb.numer as f64 / tb.denom as f64);

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| app_error("E_PEAKS_DECODER", format!("make decoder failed: {}", e)))?;

    let mut bucketer = Bucketer::new();
    // 时间戳按 i64 处理：symphonia mkv 对负的块相对时间戳会 u64 回绕(release)，
    // 转成 i64 能还原成负数
    let mut first_ts: Option<i64> = None;
    let mut container_min_ts: Option<i64> = None;
    let mut sample_rate: Option<u32> = None;
    let mut gap_filled_secs = 0.0f64;
    // 整文件每声道 abs peak（线性 0..~1+）。在解码循环里顺便累计，避免另跑一遍。
    let mut peak_l: f32 = 0.0;
    let mut peak_r: f32 = 0.0;
    let mut peak_overall: f32 = 0.0;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        match format.next_packet() {
            Ok(packet) => {
                let ts = packet.ts() as i64;
                if container_min_ts.map_or(true, |m| ts < m) {
                    container_min_ts = Some(ts);
                }
                if packet.track_id() != track_id {
                    continue;
                }
                match decoder.decode(&packet) {
                    Ok(audio_buf) => {
                        let spec = *audio_buf.spec();
                        if audio_buf.frames() == 0 {
                            continue;
                        }
                        // 时间轴以解码输出的采样率为准(容器声明可能写错)
                        let rate = *sample_rate.get_or_insert(spec.rate.max(1));
                        // 流内时间戳缺口(音轨中途断开、首样本时长被拉长的分片 MP4、
                        // 解码失败被跳过的包)：mpv 按时间戳播放，这里补静音保持对齐
                        match (first_ts, time_base) {
                            (None, _) => first_ts = Some(ts),
                            (Some(first), Some(tb)) => {
                                let expected = ((ts as f64 - first as f64) * tb * rate as f64).round();
                                let behind = expected - bucketer.total_frames as f64;
                                if behind > GAP_TOLERANCE_SECS * rate as f64
                                    && gap_filled_secs < MAX_GAP_FILL_SECS
                                {
                                    let secs = (behind / rate as f64)
                                        .min(MAX_GAP_FILL_SECS - gap_filled_secs);
                                    gap_filled_secs += secs;
                                    bucketer.push_silence((secs * rate as f64) as u64);
                                }
                            }
                            _ => {}
                        }
                        let capacity = audio_buf.capacity() as u64;
                        let needed = capacity as usize * spec.channels.count();
                        if sample_buf.as_ref().map_or(true, |b| b.capacity() < needed) {
                            sample_buf = Some(SampleBuffer::<f32>::new(capacity, spec));
                        }
                        let buf = sample_buf.as_mut().expect("sample buffer allocated above");
                        buf.copy_interleaved_ref(audio_buf);
                        let ch = spec.channels.count().max(1);
                        // interleaved layout：一帧 = ch 个连续样本
                        for frame in buf.samples().chunks_exact(ch) {
                            let mut fmax = f32::MIN;
                            let mut fmin = f32::MAX;
                            for (c, &s) in frame.iter().enumerate() {
                                if s > fmax {
                                    fmax = s;
                                }
                                if s < fmin {
                                    fmin = s;
                                }
                                let abs = s.abs();
                                if abs > peak_overall {
                                    peak_overall = abs;
                                }
                                if c == 0 {
                                    if abs > peak_l {
                                        peak_l = abs;
                                    }
                                } else if c == 1 && abs > peak_r {
                                    peak_r = abs;
                                }
                            }
                            bucketer.push_frame(fmax, fmin);
                        }
                    }
                    Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                    Err(_) => break,
                }
            }
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(_) => break,
        }
    }

    let (peaks, frames_per_peak, total_frames) = bucketer.finish();
    if total_frames == 0 {
        return Err(app_error("E_PEAKS_EMPTY", "no samples decoded"));
    }
    let sample_rate = sample_rate.unwrap_or(declared_rate);

    let start_time = detect_start_time(
        file_path,
        &container,
        mkv.as_ref(),
        track_id,
        &codec_params,
        sample_rate,
        first_ts,
        container_min_ts,
        time_base,
    );

    Ok(PeaksData {
        peaks,
        frames_per_peak,
        total_frames,
        start_time,
        duration: total_frames as f64 / sample_rate as f64,
        sample_rate,
        channels,
        bit_depth,
        peak_l,
        peak_r: if channels >= 2 { Some(peak_r) } else { None },
        peak_overall,
    })
}

/// 解码第 0 帧在 mpv 时间轴上的秒数(§6.32)。规则逐条用 mpv 实播对拍过：
/// - MP4/MOV/M4A：音轨 elst(空编辑 → 正偏移；media_time → priming 负偏移)
/// - MKV/WebM：音轨首包 − 首个 Cluster 时间戳(mpv 的 start_time) − CodecDelay；
///   读不到 Cluster 时间戳时退回全轨最早包时间戳
/// - 裸 MP3：LAME 头记录的 encoder+decoder delay(无头时 mpv 也不裁 → 0)
/// - 其余(WAV/FLAC/Ogg/ADTS…)：0
#[allow(clippy::too_many_arguments)]
fn detect_start_time(
    path: &str,
    container: &Container,
    mkv: Option<&media_timing::MkvInfo>,
    track_id: u32,
    params: &symphonia::core::codecs::CodecParameters,
    sample_rate: u32,
    first_ts: Option<i64>,
    container_min_ts: Option<i64>,
    time_base: Option<f64>,
) -> f64 {
    let secs = match container {
        Container::Mp4 => media_timing::mp4_audio_start(path, track_id as usize),
        Container::Matroska => match (first_ts, time_base) {
            (Some(ts), Some(tb)) => {
                let first = ts as f64 * tb;
                let base = mkv
                    .and_then(|m| m.first_cluster)
                    .unwrap_or_else(|| container_min_ts.unwrap_or(ts).min(ts) as f64 * tb);
                // CodecDelay 解析失败只丢这一项，不连带丢掉起点偏移
                let delay = mkv
                    .and_then(|m| m.tracks.iter().find(|t| t.number == track_id as u64))
                    .map(|t| t.codec_delay)
                    .unwrap_or(0.0);
                Some(first - base - delay)
            }
            _ => None,
        },
        Container::Other => {
            if params.codec == CODEC_TYPE_MP3 {
                params.delay.map(|d| -(d as f64) / sample_rate.max(1) as f64)
            } else {
                None
            }
        }
    };
    // 合理性闸门：异常时间戳(回绕 / 损坏)退回 0 = 旧行为
    secs.filter(|v| v.is_finite() && v.abs() < 86_400.0).unwrap_or(0.0)
}

/// 文件内容指纹（大小 + 修改时间 ms）。
/// peaks 缓存键的组成部分：同路径文件被重新导出/覆盖后（AI 配音工作流的
/// 常态操作），前端旧波形缓存立即失效，不再出现"静音区显示旧内容波形"。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub size: u64,
    pub mtime_ms: u64,
}

#[tauri::command]
pub fn file_fingerprint(file_path: String) -> Result<FileFingerprint, String> {
    let meta = std::fs::metadata(&file_path)
        .map_err(|e| app_error("E_FINGERPRINT_STAT", format!("stat failed: {}", e)))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileFingerprint {
        size: meta.len(),
        mtime_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(frames: &[f32]) -> (Vec<f32>, u32, u64) {
        let mut b = Bucketer::new();
        for &v in frames {
            b.push_frame(v, v);
        }
        b.finish()
    }

    #[test]
    fn short_input_keeps_initial_resolution_and_partial_bucket() {
        let frames: Vec<f32> = (0..40).map(|i| i as f32).collect();
        let (peaks, fpp, total) = run(&frames);
        assert_eq!(fpp, INITIAL_FRAMES_PER_PEAK);
        assert_eq!(total, 40);
        // 16 + 16 + 8(不满) = 3 桶
        assert_eq!(peaks, vec![15.0, 0.0, 31.0, 16.0, 39.0, 32.0]);
    }

    #[test]
    fn halving_keeps_buckets_aligned_to_frame_index() {
        let n = INITIAL_FRAMES_PER_PEAK as usize * MAX_BUCKETS * 3 + 5;
        let mut frames = vec![0.0f32; n];
        let spike = n * 2 / 3 + 7;
        frames[spike] = 1.0;
        let (peaks, fpp, total) = run(&frames);
        assert_eq!(total, n as u64);
        let buckets = peaks.len() / 2;
        assert!(buckets <= MAX_BUCKETS && buckets >= MAX_BUCKETS / 2);
        assert_eq!(buckets, (n as u64).div_ceil(fpp as u64) as usize);
        // 尖峰只出现在它所属的那一桶
        let hot: Vec<usize> = (0..buckets).filter(|&i| peaks[2 * i] > 0.5).collect();
        assert_eq!(hot, vec![spike / fpp as usize]);
    }

    #[test]
    fn push_silence_matches_frame_by_frame_zeros() {
        // 跨越多次合并边界、首尾都落在桶中间
        let lead = 37usize;
        let gap = (INITIAL_FRAMES_PER_PEAK as usize * MAX_BUCKETS * 3) as u64 + 11;
        let tail = 5usize;
        let mut a = Bucketer::new();
        let mut b = Bucketer::new();
        for i in 0..lead {
            a.push_frame(i as f32, -(i as f32));
            b.push_frame(i as f32, -(i as f32));
        }
        a.push_silence(gap);
        for _ in 0..gap {
            b.push_frame(0.0, 0.0);
        }
        for _ in 0..tail {
            a.push_frame(0.5, -0.5);
            b.push_frame(0.5, -0.5);
        }
        assert_eq!(a.finish(), b.finish());
    }

    /// 媒体对拍(手动)：`MPLAYER_TIMING_MEDIA=<dir> cargo test -- --ignored --nocapture`
    /// (可选 `MPLAYER_TIMING_AUDIO_INDEX=<n>` 选第 n 条音轨)
    /// 打印每个文件的 start_time 与首个脉冲(|x|>0.3)在 mpv 时间轴上的位置。
    #[test]
    #[ignore]
    fn print_timeline_of_media_dir() {
        let Ok(dir) = std::env::var("MPLAYER_TIMING_MEDIA") else {
            return;
        };
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            // symphonia-format-mkv 对负的块相对时间戳在 debug 构建下会溢出 panic(上游问题)
            let path = p.to_str().unwrap().to_string();
            let aid = std::env::var("MPLAYER_TIMING_AUDIO_INDEX").ok().and_then(|v| v.parse().ok());
            let res = std::panic::catch_unwind(move || compute_peaks(&path, aid));
            match res {
                Ok(Ok(d)) => {
                    let bucket_secs = d.frames_per_peak as f64 / d.sample_rate as f64;
                    // onset：此前 ≥100ms 低于阈值后第一次超过 0.3 的桶
                    let quiet_buckets = (0.1 / bucket_secs).ceil() as usize;
                    let mut onsets = Vec::new();
                    let mut quiet = usize::MAX;
                    for i in 0..d.peaks.len() / 2 {
                        if d.peaks[2 * i] > 0.3 {
                            if quiet >= quiet_buckets {
                                onsets.push(format!("{:.5}", d.start_time + i as f64 * bucket_secs));
                            }
                            quiet = 0;
                        } else {
                            quiet = quiet.saturating_add(1);
                        }
                    }
                    println!(
                        "TIMING {name} start={:+.6} fpp={} end={:.6} onsets=[{}]",
                        d.start_time,
                        d.frames_per_peak,
                        d.start_time + d.duration,
                        onsets.join(", ")
                    );
                }
                Ok(Err(err)) => println!("TIMING {name} ERR {err}"),
                Err(_) => println!("TIMING {name} PANIC (symphonia)"),
            }
        }
    }
}
