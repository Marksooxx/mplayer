use serde::Serialize;
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

fn app_error(code: &str, message: impl Into<String>) -> String {
    format!("[{}] {}", code, message.into())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeaksData {
    /// 交替 max/min 值（WaveSurfer.js 期望的格式）
    pub peaks: Vec<f32>,
    /// 音频时长（秒）
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

#[tauri::command]
pub async fn calculate_peaks(
    file_path: String,
    samples_per_pixel: u32,
) -> Result<PeaksData, String> {
    tauri::async_runtime::spawn_blocking(move || calculate_peaks_sync(file_path, samples_per_pixel))
        .await
        .map_err(|e| app_error("E_PEAKS_TASK_JOIN", format!("join task failed: {}", e)))?
}

fn calculate_peaks_sync(file_path: String, samples_per_pixel: u32) -> Result<PeaksData, String> {
    let file = File::open(&file_path)
        .map_err(|e| app_error("E_PEAKS_OPEN_FILE", format!("open failed: {}", e)))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(&file_path).extension() {
        hint.with_extension(ext.to_str().unwrap_or(""));
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| app_error("E_PEAKS_PROBE", format!("probe failed: {}", e)))?;

    let mut format = probed.format;

    // 取第一条音频轨；视频文件可能也有，没有则报错
    let audio_track = format
        .tracks()
        .iter()
        .find(|t| {
            t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL
                && t.codec_params.sample_rate.is_some()
        })
        .ok_or_else(|| app_error("E_PEAKS_TRACK", "no audio track in file"))?;

    let sample_rate = audio_track.codec_params.sample_rate.unwrap_or(44100);
    let channels = audio_track
        .codec_params
        .channels
        .map(|c| c.count() as u32)
        .unwrap_or(2)
        .max(1);
    // bits_per_sample 在 lossy 容器里通常是 None，前端按 null 处理
    let bit_depth = audio_track.codec_params.bits_per_sample;
    let track_id = audio_track.id;
    let codec_params = audio_track.codec_params.clone();

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| app_error("E_PEAKS_DECODER", format!("make decoder failed: {}", e)))?;

    let mut all_samples: Vec<f32> = Vec::new();
    // 整文件每声道 abs peak（线性 0..~1+）。在解码循环里顺便累计，避免另跑一遍。
    let mut peak_l: f32 = 0.0;
    let mut peak_r: f32 = 0.0;
    let mut peak_overall: f32 = 0.0;

    loop {
        match format.next_packet() {
            Ok(packet) => {
                if packet.track_id() != track_id {
                    continue;
                }
                match decoder.decode(&packet) {
                    Ok(audio_buf) => {
                        let spec = *audio_buf.spec();
                        let capacity = audio_buf.capacity() as u64;
                        let mut sample_buf = SampleBuffer::<f32>::new(capacity, spec);
                        sample_buf.copy_interleaved_ref(audio_buf);
                        let samples = sample_buf.samples();
                        // interleaved layout：sample[i] 所属 channel = i % channels
                        for (i, &s) in samples.iter().enumerate() {
                            let abs = s.abs();
                            if abs > peak_overall {
                                peak_overall = abs;
                            }
                            let ch = (i as u32) % channels;
                            if ch == 0 {
                                if abs > peak_l {
                                    peak_l = abs;
                                }
                            } else if ch == 1 && abs > peak_r {
                                peak_r = abs;
                            }
                        }
                        all_samples.extend_from_slice(samples);
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

    if all_samples.is_empty() {
        return Err(app_error("E_PEAKS_EMPTY", "no samples decoded"));
    }

    let chunk_size = (samples_per_pixel.max(1) * channels) as usize;
    let mut peaks: Vec<f32> = Vec::with_capacity(all_samples.len() / chunk_size.max(1) * 2);
    for chunk in all_samples.chunks(chunk_size) {
        let mut max = f32::MIN;
        let mut min = f32::MAX;
        for &s in chunk {
            if s > max {
                max = s;
            }
            if s < min {
                min = s;
            }
        }
        peaks.push(max);
        peaks.push(min);
    }

    let total_samples = all_samples.len() as f64 / channels as f64;
    let duration = total_samples / sample_rate as f64;

    Ok(PeaksData {
        peaks,
        duration,
        sample_rate,
        channels,
        bit_depth,
        peak_l,
        peak_r: if channels >= 2 { Some(peak_r) } else { None },
        peak_overall,
    })
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
