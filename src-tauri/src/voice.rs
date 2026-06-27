//! On-device voice capture + transcription (optional, behind the `voice` feature).
//!
//! cpal's Stream is not Send on Windows, so the stream is owned entirely by a
//! dedicated recording thread. We communicate only via Arc-shared buffers and an
//! atomic stop flag - nothing that isn't Send/Sync crosses a thread boundary.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

const TARGET_SAMPLE_RATE: u32 = 16_000;
const WHISPER_INITIAL_PROMPT: &str =
    "Personal reminders, tasks, shopping lists, appointments, and quick notes.";

/// Prefer larger English models when the configured path is missing.
const MODEL_FALLBACK_ORDER: &[&str] = &[
    "ggml-medium.en.bin",
    "ggml-small.en.bin",
    "ggml-base.en.bin",
    "ggml-tiny.en.bin",
];

struct Session {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: Arc<Mutex<u32>>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

#[cfg(feature = "voice")]
struct CachedModel {
    path: String,
    ctx: whisper_rs::WhisperContext,
}

#[cfg(feature = "voice")]
static MODEL_CACHE: Mutex<Option<CachedModel>> = Mutex::new(None);

pub fn start_recording() -> Result<(), String> {
    let mut guard = SESSION.lock().map_err(|_| "lock poisoned")?;
    if guard.is_some() {
        return Err("already recording".into());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let sample_rate = Arc::new(Mutex::new(TARGET_SAMPLE_RATE));

    let stop_t = stop.clone();
    let samples_t = samples.clone();
    let sr_t = sample_rate.clone();

    let handle = std::thread::spawn(move || {
        if let Err(e) = run_recording_thread(stop_t, samples_t, sr_t) {
            eprintln!("voice recording failed: {e}");
        }
    });

    *guard = Some(Session {
        stop,
        handle: Some(handle),
        samples,
        sample_rate,
    });
    Ok(())
}

pub fn stop_and_transcribe(model_path: String) -> Result<String, String> {
    let mut session = SESSION
        .lock()
        .map_err(|_| "lock poisoned")?
        .take()
        .ok_or("not recording")?;

    session.stop.store(true, Ordering::Relaxed);
    if let Some(h) = session.handle.take() {
        let _ = h.join();
    }

    let samples = session.samples.lock().unwrap().clone();
    let in_rate = *session.sample_rate.lock().unwrap();
    if samples.is_empty() {
        return Ok(String::new());
    }

    let resolved = resolve_model_path(&model_path)?;
    let mut pcm = resample_to_16k(&samples, in_rate);
    preprocess_pcm(&mut pcm);
    if pcm.is_empty() {
        return Ok(String::new());
    }

    transcribe_pcm(&pcm, &resolved)
}

#[cfg(feature = "voice")]
fn with_cached_context<F, R>(model_path: &str, f: F) -> Result<R, String>
where
    F: FnOnce(&whisper_rs::WhisperContext) -> Result<R, String>,
{
    use whisper_rs::{WhisperContext, WhisperContextParameters};

    let mut cache = MODEL_CACHE.lock().map_err(|_| "model cache lock poisoned")?;
    let needs_reload = cache
        .as_ref()
        .map(|c| c.path != model_path)
        .unwrap_or(true);

    if needs_reload {
        let mut ctx_params = WhisperContextParameters::default();
        ctx_params.use_gpu(true);

        let ctx = WhisperContext::new_with_params(model_path, ctx_params)
            .map_err(|e| format!("failed to load model: {e}"))?;
        *cache = Some(CachedModel {
            path: model_path.to_string(),
            ctx,
        });
    }

    let cached = cache
        .as_ref()
        .ok_or_else(|| "model cache missing after load".to_string())?;
    f(&cached.ctx)
}

/// Warm the Whisper model in memory so the first capture is faster.
pub fn preload_model(model_path: String) -> Result<(), String> {
    let resolved = resolve_model_path(&model_path)?;
    with_cached_context(&resolved, |_| Ok(()))
}

fn run_recording_thread(
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: Arc<Mutex<u32>>,
) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no microphone found")?;

    let (stream_config, sample_format, rate) = pick_input_config(&device)?;
    *sample_rate.lock().unwrap() = rate;

    let buf = samples.clone();
    let err_fn = |e| eprintln!("microphone stream error: {e}");

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                push_mono_samples(&buf, data, stream_config.channels as usize, |s| s);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                push_mono_samples(&buf, data, stream_config.channels as usize, |s| {
                    s as f32 / 32768.0
                });
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            &stream_config,
            move |data: &[i32], _: &cpal::InputCallbackInfo| {
                push_mono_samples(&buf, data, stream_config.channels as usize, |s| {
                    (s as f64 / i32::MAX as f64) as f32
                });
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                push_mono_samples(&buf, data, stream_config.channels as usize, |s| {
                    (s as f32 / 32768.0) - 1.0
                });
            },
            err_fn,
            None,
        ),
        other => {
            return Err(format!("unsupported microphone format: {other:?}"));
        }
    }
    .map_err(|e| format!("could not open microphone: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("could not start microphone: {e}"))?;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    drop(stream);
    Ok(())
}

fn pick_input_config(
    device: &cpal::Device,
) -> Result<(cpal::StreamConfig, cpal::SampleFormat, u32), String> {
    use cpal::traits::DeviceTrait;

    let supported: Vec<_> = device
        .supported_input_configs()
        .map_err(|e| format!("could not query microphone: {e}"))?
        .collect();

    for &target_rate in &[TARGET_SAMPLE_RATE, 48_000, 44_100, 24_000] {
        for cfg in &supported {
            if cfg.min_sample_rate().0 > target_rate || cfg.max_sample_rate().0 < target_rate {
                continue;
            }
            let stream_config = cpal::StreamConfig {
                channels: cfg.channels(),
                sample_rate: cpal::SampleRate(target_rate),
                buffer_size: cpal::BufferSize::Default,
            };
            return Ok((stream_config, cfg.sample_format(), target_rate));
        }
    }

    for cfg in &supported {
        let rate = cfg.min_sample_rate().0;
        let stream_config = cpal::StreamConfig {
            channels: cfg.channels(),
            sample_rate: cpal::SampleRate(rate),
            buffer_size: cpal::BufferSize::Default,
        };
        return Ok((stream_config, cfg.sample_format(), rate));
    }

    let default = device
        .default_input_config()
        .map_err(|e| format!("could not read default microphone config: {e}"))?;
    let rate = default.sample_rate().0;
    let stream_config: cpal::StreamConfig = default.clone().into();
    Ok((stream_config, default.sample_format(), rate))
}

fn push_mono_samples<T, F>(buf: &Arc<Mutex<Vec<f32>>>, data: &[T], channels: usize, convert: F)
where
    F: Fn(T) -> f32 + Copy,
    T: Copy,
{
    let channels = channels.max(1);
    let mut out = buf.lock().unwrap();
    for frame in data.chunks(channels) {
        let mono = frame.iter().map(|&s| convert(s)).sum::<f32>() / channels as f32;
        out.push(mono);
    }
}

fn resolve_model_path(configured: &str) -> Result<String, String> {
    let configured_path = Path::new(configured);
    if configured_path.exists() {
        return Ok(configured.to_string());
    }

    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Some(parent) = configured_path.parent() {
        search_dirs.push(parent.to_path_buf());
    }

    if let Ok(cwd) = std::env::current_dir() {
        search_dirs.push(cwd.join("models"));
        search_dirs.push(cwd.join("tangent").join("models"));
    }

    for dir in search_dirs {
        for name in MODEL_FALLBACK_ORDER {
            let candidate = dir.join(name);
            if candidate.exists() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }

    Err(format!(
        "Whisper model not found at '{configured}'. Download ggml-small.en.bin or ggml-base.en.bin into a models/ folder."
    ))
}

fn resample_to_16k(input: &[f32], in_rate: u32) -> Vec<f32> {
    if in_rate == TARGET_SAMPLE_RATE || input.is_empty() {
        return input.to_vec();
    }
    let ratio = TARGET_SAMPLE_RATE as f64 / in_rate as f64;
    let out_len = ((input.len() as f64) * ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Trim leading/trailing silence and normalize level for Whisper.
fn preprocess_pcm(pcm: &mut Vec<f32>) {
    trim_silence(pcm, 0.008);
    if pcm.is_empty() {
        return;
    }

    let peak = pcm.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    if peak > 1e-5 {
        let gain = 0.95 / peak;
        for sample in pcm.iter_mut() {
            *sample *= gain;
        }
    }
}

fn trim_silence(pcm: &mut Vec<f32>, threshold: f32) {
    if pcm.is_empty() {
        return;
    }

    const WINDOW: usize = 320; // 20 ms at 16 kHz
    let is_silent = |start: usize| -> bool {
        let end = (start + WINDOW).min(pcm.len());
        if end <= start {
            return true;
        }
        let rms = (pcm[start..end]
            .iter()
            .map(|s| s * s)
            .sum::<f32>()
            / (end - start) as f32)
            .sqrt();
        rms < threshold
    };

    let mut start = 0usize;
    while start + WINDOW <= pcm.len() && is_silent(start) {
        start += WINDOW / 2;
    }

    let mut end = pcm.len();
    while end > start + WINDOW && is_silent(end - WINDOW) {
        end -= WINDOW / 2;
    }

    if start > 0 || end < pcm.len() {
        *pcm = pcm[start..end].to_vec();
    }
}

#[cfg(feature = "voice")]
fn transcribe_pcm(pcm: &[f32], model_path: &str) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy};

    with_cached_context(model_path, |ctx| {
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("failed to create state: {e}"))?;

        let threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4)
            .clamp(2, 8);

        let mut params = FullParams::new(SamplingStrategy::BeamSearch {
            beam_size: 5,
            patience: -1.0,
        });
        params.set_n_threads(threads);
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_language(Some("en"));
        params.set_translate(false);
        params.set_temperature(0.0);
        params.set_temperature_inc(0.2);
        params.set_single_segment(true);
        params.set_no_context(false);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_initial_prompt(WHISPER_INITIAL_PROMPT);

        state
            .full(params, pcm)
            .map_err(|e| format!("transcription failed: {e}"))?;

        let n = state.full_n_segments();
        let mut text = String::new();
        for i in 0..n {
            if let Some(seg) = state.get_segment(i) {
                if let Ok(s) = seg.to_str() {
                    text.push_str(s);
                }
            }
        }
        Ok(text.trim().to_string())
    })
}
