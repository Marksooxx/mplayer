//! 容器级时间轴 / 轨道信息：让波形与 mpv 的时间轴、音轨编号对齐（ARCHITECTURE §6.32）。
//!
//! symphonia 0.5.5 按解码顺序吐样本，不应用容器里的起点 / priming 信息；
//! mpv(FFmpeg / demux_mkv) 则会应用。两边差出来的就是波形相对声音的固定偏移
//! (实测 AAC 21–23ms、LAME MP3 25ms、音频晚于视频起播时可达数百 ms)。
//! 这里只做最小的只读解析，返回的秒数交给前端按时间摆放 peaks，不在解码侧裁样本。
//!
//! - MP4/MOV/M4A：音轨 `elst`。起点 = Σ空编辑(media_time=-1)时长/mvhd_timescale
//!   − 首个非空编辑 media_time/mdhd_timescale。(FFmpeg 同款语义，多段编辑只取首段)
//! - MKV/WebM：mpv demux_mkv 以首个 Cluster 的 Timestamp 为起点(probe_first_timestamp)，
//!   包 pts = 块时间戳 − CodecDelay。
//! - 音轨顺序：mpv 的 aid N = 容器里第 N 条音轨(MP4 trak 顺序 / MKV TrackEntry 顺序)。
//!   symphonia 对 MP4 里解不了的音轨(如 AC3)不给采样率，无法与视频轨区分，所以自己数。
//!
//! 任何解析失败都返回 None，调用方退化为旧行为。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

pub enum Container {
    Mp4,
    Matroska,
    Other,
}

/// 按文件头魔数判断容器(不信扩展名)。
pub fn sniff_container(path: &str) -> Container {
    let mut head = [0u8; 12];
    let Ok(mut f) = File::open(path) else {
        return Container::Other;
    };
    if f.read_exact(&mut head).is_err() {
        return Container::Other;
    }
    if head[0..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return Container::Matroska;
    }
    match &head[4..8] {
        b"ftyp" | b"moov" | b"mdat" | b"free" | b"wide" | b"skip" | b"pnot" => Container::Mp4,
        _ => Container::Other,
    }
}

// ---------------------------------------------------------------- MP4 ----

fn rd_u32(f: &mut File) -> Option<u32> {
    let mut b = [0u8; 4];
    f.read_exact(&mut b).ok()?;
    Some(u32::from_be_bytes(b))
}

fn rd_u64(f: &mut File) -> Option<u64> {
    let mut b = [0u8; 8];
    f.read_exact(&mut b).ok()?;
    Some(u64::from_be_bytes(b))
}

/// 列出 [start, end) 范围内的 box：(类型, body 起点, body 终点)。
fn mp4_boxes(f: &mut File, start: u64, end: u64) -> Vec<([u8; 4], u64, u64)> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos + 8 <= end {
        if f.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let Some(size32) = rd_u32(f) else { break };
        let mut ty = [0u8; 4];
        if f.read_exact(&mut ty).is_err() {
            break;
        }
        let (hdr, size) = match size32 {
            1 => match rd_u64(f) {
                Some(l) => (16u64, l),
                None => break,
            },
            0 => (8u64, end - pos),
            n => (8u64, n as u64),
        };
        if size < hdr || pos.saturating_add(size) > end {
            break;
        }
        out.push((ty, pos + hdr, pos + size));
        pos += size;
    }
    out
}

/// 读 mvhd / mdhd 的 timescale(version 0/1 的时间字段宽度不同)。
fn mp4_timescale(f: &mut File, body: u64) -> Option<f64> {
    f.seek(SeekFrom::Start(body)).ok()?;
    let version = rd_u32(f)? >> 24;
    f.seek(SeekFrom::Current(if version == 1 { 16 } else { 8 })).ok()?;
    let ts = rd_u32(f)?;
    (ts > 0).then_some(ts as f64)
}

/// moov 及其子 box；mvhd timescale。
fn mp4_moov(f: &mut File) -> Option<(Vec<([u8; 4], u64, u64)>, f64)> {
    let len = f.metadata().ok()?.len();
    let moov = mp4_boxes(f, 0, len).into_iter().find(|b| &b.0 == b"moov")?;
    let kids = mp4_boxes(f, moov.1, moov.2);
    let mvhd = *kids.iter().find(|b| &b.0 == b"mvhd")?;
    let movie_ts = mp4_timescale(f, mvhd.1)?;
    Some((kids, movie_ts))
}

/// trak 的 mdia 子 box 与 handler 类型。
fn mp4_trak_mdia(f: &mut File, trak: ([u8; 4], u64, u64)) -> Option<(Vec<([u8; 4], u64, u64)>, [u8; 4])> {
    let trak_kids = mp4_boxes(f, trak.1, trak.2);
    let mdia = *trak_kids.iter().find(|b| &b.0 == b"mdia")?;
    let mdia_kids = mp4_boxes(f, mdia.1, mdia.2);
    let hdlr = *mdia_kids.iter().find(|b| &b.0 == b"hdlr")?;
    f.seek(SeekFrom::Start(hdlr.1 + 8)).ok()?;
    let mut handler = [0u8; 4];
    f.read_exact(&mut handler).ok()?;
    Some((mdia_kids, handler))
}

/// 所有音轨(hdlr=soun)在 moov 内的 trak 下标，按容器顺序。
/// symphonia isomp4 的 Track.id 就是 trak 下标。
pub fn mp4_audio_traks(path: &str) -> Option<Vec<u32>> {
    let mut f = File::open(path).ok()?;
    let (kids, _) = mp4_moov(&mut f)?;
    let mut out = Vec::new();
    for (i, trak) in kids.iter().filter(|b| &b.0 == b"trak").enumerate() {
        if let Some((_, handler)) = mp4_trak_mdia(&mut f, *trak) {
            if &handler == b"soun" {
                out.push(i as u32);
            }
        }
    }
    Some(out)
}

/// 第 `trak_index` 个 trak 的首样本在展示时间轴上的秒数。
/// 该 trak 不是音轨或文件不是 MP4 时返回 None。
pub fn mp4_audio_start(path: &str, trak_index: usize) -> Option<f64> {
    let mut f = File::open(path).ok()?;
    let (kids, movie_ts) = mp4_moov(&mut f)?;
    let trak = *kids.iter().filter(|b| &b.0 == b"trak").nth(trak_index)?;
    let (mdia_kids, handler) = mp4_trak_mdia(&mut f, trak)?;
    if &handler != b"soun" {
        return None;
    }
    let mdhd = *mdia_kids.iter().find(|b| &b.0 == b"mdhd")?;
    let media_ts = mp4_timescale(&mut f, mdhd.1)?;

    // 无编辑列表 = 从 0 开始
    let trak_kids = mp4_boxes(&mut f, trak.1, trak.2);
    let Some(edts) = trak_kids.iter().find(|b| &b.0 == b"edts") else {
        return Some(0.0);
    };
    let Some(elst) = mp4_boxes(&mut f, edts.1, edts.2)
        .into_iter()
        .find(|b| &b.0 == b"elst")
    else {
        return Some(0.0);
    };
    f.seek(SeekFrom::Start(elst.1)).ok()?;
    let version = rd_u32(&mut f)? >> 24;
    let count = rd_u32(&mut f)?;
    let mut empty = 0.0f64;
    for _ in 0..count.min(64) {
        let (segment, media_time) = if version == 1 {
            (rd_u64(&mut f)? as f64, rd_u64(&mut f)? as i64)
        } else {
            (rd_u32(&mut f)? as f64, rd_u32(&mut f)? as i32 as i64)
        };
        rd_u32(&mut f)?; // media_rate
        if media_time == -1 {
            empty += segment / movie_ts;
            continue;
        }
        return Some(empty - media_time as f64 / media_ts);
    }
    Some(empty)
}

// ---------------------------------------------------------------- MKV ----

/// EBML 变长整数。`keep_marker=true` 用于元素 ID(ID 含长度标记位)。
fn ebml_vint(f: &mut File, keep_marker: bool) -> Option<(u64, u64)> {
    let mut b = [0u8; 1];
    f.read_exact(&mut b).ok()?;
    let lz = b[0].leading_zeros() as u64;
    if lz >= 8 {
        return None;
    }
    let len = lz + 1;
    let mut v = if keep_marker {
        b[0] as u64
    } else {
        (b[0] as u64) & ((1u64 << (8 - len)) - 1)
    };
    for _ in 1..len {
        f.read_exact(&mut b).ok()?;
        v = (v << 8) | b[0] as u64;
    }
    Some((v, len))
}

/// 读一个元素头，返回 (id, body 起点, body 终点)；unknown-size 元素的终点取 `limit`。
fn ebml_header(f: &mut File, pos: u64, limit: u64) -> Option<(u64, u64, u64)> {
    f.seek(SeekFrom::Start(pos)).ok()?;
    let (id, id_len) = ebml_vint(f, true)?;
    let (size, size_len) = ebml_vint(f, false)?;
    let body = pos + id_len + size_len;
    let unknown = size == (1u64 << (7 * size_len)) - 1;
    let end = if unknown {
        limit
    } else {
        body.saturating_add(size).min(limit)
    };
    Some((id, body, end))
}

fn ebml_children(f: &mut File, start: u64, end: u64) -> Vec<(u64, u64, u64)> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos < end {
        let Some((id, body, bend)) = ebml_header(f, pos, end) else {
            break;
        };
        out.push((id, body, bend));
        if bend <= pos {
            break;
        }
        pos = bend;
    }
    out
}

fn ebml_uint(f: &mut File, start: u64, end: u64) -> Option<u64> {
    if end < start || end - start > 8 {
        return None;
    }
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut v = 0u64;
    let mut b = [0u8; 1];
    for _ in start..end {
        f.read_exact(&mut b).ok()?;
        v = (v << 8) | b[0] as u64;
    }
    Some(v)
}

fn child_uint(f: &mut File, kids: &[(u64, u64, u64)], id: u64) -> Option<u64> {
    let c = kids.iter().find(|c| c.0 == id)?;
    ebml_uint(f, c.1, c.2)
}

const EBML_SEGMENT: u64 = 0x1853_8067;
const EBML_SEEK_HEAD: u64 = 0x114D_9B74;
const EBML_SEEK: u64 = 0x4DBB;
const EBML_SEEK_ID: u64 = 0x53AB;
const EBML_SEEK_POSITION: u64 = 0x53AC;
const EBML_INFO: u64 = 0x1549_A966;
const EBML_TIMESTAMP_SCALE: u64 = 0x2A_D7B1;
const EBML_TRACKS: u64 = 0x1654_AE6B;
const EBML_CLUSTER: u64 = 0x1F43_B675;
const EBML_CLUSTER_TIMESTAMP: u64 = 0xE7;
const EBML_SIMPLE_BLOCK: u64 = 0xA3;
const EBML_BLOCK_GROUP: u64 = 0xA0;
const EBML_TRACK_ENTRY: u64 = 0xAE;
const EBML_TRACK_NUMBER: u64 = 0xD7;
const EBML_TRACK_TYPE: u64 = 0x83;
const EBML_CODEC_DELAY: u64 = 0x56AA;

pub struct MkvTrack {
    /// TrackNumber(= symphonia mkv 的 Track.id)
    pub number: u64,
    /// 2 = audio
    pub track_type: u64,
    /// CodecDelay(秒)，没有该元素为 0
    pub codec_delay: f64,
}

pub struct MkvInfo {
    /// 首个 Cluster 的 Timestamp(秒) = mpv 的 demuxer start_time
    pub first_cluster: Option<f64>,
    pub tracks: Vec<MkvTrack>,
}

fn mkv_parse_tracks(f: &mut File, body: u64, end: u64) -> Vec<MkvTrack> {
    let mut out = Vec::new();
    for entry in ebml_children(f, body, end)
        .into_iter()
        .filter(|c| c.0 == EBML_TRACK_ENTRY)
    {
        let fields = ebml_children(f, entry.1, entry.2);
        let Some(number) = child_uint(f, &fields, EBML_TRACK_NUMBER) else {
            continue;
        };
        out.push(MkvTrack {
            number,
            track_type: child_uint(f, &fields, EBML_TRACK_TYPE).unwrap_or(0),
            codec_delay: child_uint(f, &fields, EBML_CODEC_DELAY).unwrap_or(0) as f64 / 1e9,
        });
    }
    out
}

/// Cluster 的 Timestamp：规范要求它排在所有 Block 之前，逐个子元素找到第一个 Block 为止。
fn mkv_cluster_timestamp(f: &mut File, body: u64, end: u64) -> Option<u64> {
    let mut pos = body;
    while pos < end {
        let (id, cbody, cend) = ebml_header(f, pos, end)?;
        match id {
            EBML_CLUSTER_TIMESTAMP => return ebml_uint(f, cbody, cend),
            EBML_SIMPLE_BLOCK | EBML_BLOCK_GROUP => return None,
            _ => {}
        }
        if cend <= pos {
            return None;
        }
        pos = cend;
    }
    None
}

fn mkv_timestamp_scale(f: &mut File, body: u64, end: u64) -> Option<u64> {
    let kids = ebml_children(f, body, end);
    child_uint(f, &kids, EBML_TIMESTAMP_SCALE).filter(|s| *s > 0)
}

/// Segment 头部信息：TimestampScale、首个 Cluster 的时间戳、各轨类型与 CodecDelay。
/// Info / Tracks 可以排在 Cluster 之后(靠 SeekHead 引用)，此时按 SeekHead 跳过去读。
pub fn mkv_info(path: &str) -> Option<MkvInfo> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let segment = ebml_children(&mut f, 0, len)
        .into_iter()
        .find(|c| c.0 == EBML_SEGMENT)?;
    let seg_body = segment.1;
    let seg_end = segment.2;

    let mut timestamp_scale: Option<u64> = None;
    let mut tracks: Option<Vec<MkvTrack>> = None;
    let mut tracks_seek: Option<u64> = None;
    let mut info_seek: Option<u64> = None;
    let mut first_cluster_raw: Option<u64> = None;

    // Segment 可能是 unknown size(直播流)：逐个跳过顶层子元素，到首个 Cluster 为止
    let mut pos = seg_body;
    while pos < seg_end {
        let Some((id, body, end)) = ebml_header(&mut f, pos, seg_end) else {
            break;
        };
        match id {
            EBML_SEEK_HEAD => {
                for seek in ebml_children(&mut f, body, end)
                    .into_iter()
                    .filter(|c| c.0 == EBML_SEEK)
                {
                    let kids = ebml_children(&mut f, seek.1, seek.2);
                    let Some(sid) = kids.iter().find(|c| c.0 == EBML_SEEK_ID) else {
                        continue;
                    };
                    // SeekID 存的是目标元素 ID 的原始字节
                    match ebml_uint(&mut f, sid.1, sid.2) {
                        Some(EBML_TRACKS) => {
                            tracks_seek = child_uint(&mut f, &kids, EBML_SEEK_POSITION)
                        }
                        Some(EBML_INFO) => info_seek = child_uint(&mut f, &kids, EBML_SEEK_POSITION),
                        _ => {}
                    }
                }
            }
            EBML_INFO => timestamp_scale = mkv_timestamp_scale(&mut f, body, end).or(timestamp_scale),
            EBML_TRACKS => tracks = Some(mkv_parse_tracks(&mut f, body, end)),
            EBML_CLUSTER => {
                first_cluster_raw = mkv_cluster_timestamp(&mut f, body, end);
                break;
            }
            _ => {}
        }
        if end <= pos {
            break;
        }
        pos = end;
    }

    if tracks.is_none() {
        if let Some(rel) = tracks_seek {
            if let Some((EBML_TRACKS, body, end)) = seg_body
                .checked_add(rel)
                .and_then(|at| ebml_header(&mut f, at, seg_end))
            {
                tracks = Some(mkv_parse_tracks(&mut f, body, end));
            }
        }
    }
    if timestamp_scale.is_none() {
        if let Some(rel) = info_seek {
            if let Some((EBML_INFO, body, end)) = seg_body
                .checked_add(rel)
                .and_then(|at| ebml_header(&mut f, at, seg_end))
            {
                timestamp_scale = mkv_timestamp_scale(&mut f, body, end);
            }
        }
    }
    let scale = timestamp_scale.unwrap_or(1_000_000);

    Some(MkvInfo {
        first_cluster: first_cluster_raw.map(|t| t as f64 * scale as f64 / 1e9),
        tracks: tracks.unwrap_or_default(),
    })
}
