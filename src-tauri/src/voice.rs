//! On-device voice capture + transcription (optional, behind the `voice` feature).
//!
//! cpal's Stream is not Send on Windows, so the stream is owned entirely by a
//! dedicated recording thread. We communicate only via Arc-shared buffers and an
//! atomic stop flag - nothing that isn't Send/Sync crosses a thread boundary.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tauri::AppHandle;
use tauri::Manager;

const TARGET_SAMPLE_RATE: u32 = 16_000;
/// Rolling buffer kept while the mic is warm — captures speech before "Listening" appears.
const PRE_ROLL_MS: u32 = 500;
const WHISPER_INITIAL_PROMPT: &str =
    "Voice note with reminders, tasks, names, times, dates, and quick ideas.";

fn mic_permission_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "System Settings → Privacy & Security → Microphone — allow Tangent.";
    }
    #[cfg(target_os = "windows")]
    {
        return "Windows Settings → Privacy & security → Microphone — turn on access and allow desktop apps.";
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return "Check system microphone permissions for this app.";
    }
}

fn default_input_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "Connect a mic and set it as the default input in System Settings → Sound.";
    }
    #[cfg(target_os = "windows")]
    {
        return "Connect a mic and set it as the default input in Windows Sound settings.";
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return "Connect a microphone and set it as the system default input.";
    }
}

/// Shipped inside the installer; users can override with a larger model in Settings.
pub const BUNDLED_MODEL_FILE: &str = "ggml-base.en.bin";

/// Prefer larger English models when searching dev / override folders.
const MODEL_FALLBACK_ORDER: &[&str] = &[
    "ggml-medium.en.bin",
    "ggml-small.en.bin",
    "ggml-base.en.bin",
    "ggml-tiny.en.bin",
];

struct MicStandby {
    shutdown: Arc<AtomicBool>,
    capturing: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    samples: Arc<Mutex<Vec<f32>>>,
    preroll: Arc<Mutex<Vec<f32>>>,
    preroll_cap: Arc<Mutex<usize>>,
    sample_rate: Arc<Mutex<u32>>,
    device_name: Arc<Mutex<String>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl MicStandby {
    fn new() -> Self {
        Self {
            shutdown: Arc::new(AtomicBool::new(false)),
            capturing: Arc::new(AtomicBool::new(false)),
            ready: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(None)),
            samples: Arc::new(Mutex::new(Vec::new())),
            preroll: Arc::new(Mutex::new(Vec::new())),
            preroll_cap: Arc::new(Mutex::new(0)),
            sample_rate: Arc::new(Mutex::new(TARGET_SAMPLE_RATE)),
            device_name: Arc::new(Mutex::new(String::new())),
            thread: Mutex::new(None),
        }
    }
}

static MIC: Mutex<Option<MicStandby>> = Mutex::new(None);

#[cfg(feature = "voice")]
struct CachedModel {
    path: String,
    ctx: whisper_rs::WhisperContext,
}

#[cfg(feature = "voice")]
static MODEL_CACHE: Mutex<Option<CachedModel>> = Mutex::new(None);

#[derive(serde::Serialize)]
pub struct MicTestResult {
    pub device: String,
    pub samples: usize,
}

/// Quick mic check: records ~1.5s and returns device name + sample count.
pub fn test_microphone() -> Result<(String, usize), String> {
    if MIC.lock()
        .map_err(|_| "lock poisoned")?
        .as_ref()
        .is_some_and(|m| m.capturing.load(Ordering::Relaxed))
    {
        return Err("Cannot test microphone while a capture is in progress.".into());
    }

    shutdown_mic_standby();

    let stop = Arc::new(AtomicBool::new(false));
    let ready = Arc::new(AtomicBool::new(false));
    let error = Arc::new(Mutex::new(None::<String>));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let sample_rate = Arc::new(Mutex::new(TARGET_SAMPLE_RATE));
    let device_name = Arc::new(Mutex::new(String::new()));

    let stop_t = stop.clone();
    let samples_t = samples.clone();
    let sr_t = sample_rate.clone();
    let ready_t = ready.clone();
    let error_t = error.clone();
    let error_report = error.clone();
    let device_name_t = device_name.clone();

    let handle = std::thread::spawn(move || {
        if let Err(e) = run_recording_thread(
            stop_t,
            samples_t,
            sr_t,
            ready_t,
            error_t,
            device_name_t,
        ) {
            if let Ok(mut err_slot) = error_report.lock() {
                if err_slot.is_none() {
                    *err_slot = Some(e);
                }
            }
        }
    });

    for _ in 0..80 {
        if ready.load(Ordering::Relaxed) {
            break;
        }
        if let Ok(err_slot) = error.lock() {
            if let Some(err) = err_slot.clone() {
                stop.store(true, Ordering::Relaxed);
                let _ = handle.join();
                return Err(err);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    if !ready.load(Ordering::Relaxed) {
        stop.store(true, Ordering::Relaxed);
        let _ = handle.join();
        return Err(format!(
            "Microphone did not start — check {hint}",
            hint = mic_permission_hint()
        ));
    }

    std::thread::sleep(std::time::Duration::from_millis(1500));
    stop.store(true, Ordering::Relaxed);
    let _ = handle.join();

    if let Ok(err_slot) = error.lock() {
        if let Some(err) = err_slot.clone() {
            return Err(err);
        }
    }

    let count = samples.lock().unwrap().len();
    let name = device_name.lock().unwrap().clone();
    if count == 0 {
        return Err(format!(
            "No audio from \"{name}\". {hint}",
            hint = mic_permission_hint()
        ));
    }
    let _ = warm_microphone();
    Ok((name, count))
}

/// Keep the default microphone open so capture starts instantly with pre-roll audio.
pub fn warm_microphone() -> Result<(), String> {
    ensure_mic_standby()
}

pub fn start_recording() -> Result<(), String> {
    ensure_mic_standby()?;
    let guard = MIC.lock().map_err(|_| "lock poisoned")?;
    let mic = guard
        .as_ref()
        .ok_or("microphone pipeline missing after warm-up")?;

    if mic.capturing.load(Ordering::Relaxed) {
        return Err("already recording".into());
    }

    let pre = mic.preroll.lock().map_err(|_| "lock poisoned")?.clone();
    {
        let mut samples = mic.samples.lock().map_err(|_| "lock poisoned")?;
        samples.clear();
        samples.extend(pre);
    }
    mic.capturing.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn stop_and_transcribe(app: &AppHandle, model_path: String) -> Result<String, String> {
    let guard = MIC.lock().map_err(|_| "lock poisoned")?;
    let mic = guard
        .as_ref()
        .ok_or("microphone is not warm — try again in a moment")?;

    mic.capturing.store(false, Ordering::SeqCst);
    std::thread::sleep(std::time::Duration::from_millis(60));

    if let Ok(err_slot) = mic.error.lock() {
        if let Some(err) = err_slot.clone() {
            return Err(err);
        }
    }

    let samples = mic.samples.lock().map_err(|_| "lock poisoned")?.clone();
    let in_rate = *mic.sample_rate.lock().map_err(|_| "lock poisoned")?;
    let mic_name = mic.device_name.lock().map_err(|_| "lock poisoned")?.clone();

    mic.samples.lock().map_err(|_| "lock poisoned")?.clear();

    if samples.is_empty() {
        let hint = if mic_name.is_empty() {
            mic_permission_hint().into()
        } else {
            format!("using \"{mic_name}\" — {hint}", hint = mic_permission_hint())
        };
        return Err(format!("no audio captured — {hint}"));
    }

    let resolved = resolve_model_path(app, &model_path)?;
    let mut pcm = resample_to_16k(&samples, in_rate);
    preprocess_pcm(&mut pcm);
    if pcm.is_empty() {
        return Err("no speech detected in recording".into());
    }

    transcribe_pcm(&pcm, &resolved)
}

fn shutdown_mic_standby() {
    let mic = MIC.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mic) = mic {
        mic.shutdown.store(true, Ordering::SeqCst);
        mic.capturing.store(false, Ordering::SeqCst);
        if let Ok(mut handle) = mic.thread.lock() {
            if let Some(h) = handle.take() {
                let _ = h.join();
            }
        }
    }
}

fn ensure_mic_standby() -> Result<(), String> {
    let mut guard = MIC.lock().map_err(|_| "lock poisoned")?;
    let needs_spawn = guard
        .as_ref()
        .map(|m| m.thread.lock().map(|t| t.is_none()).unwrap_or(true))
        .unwrap_or(true);

    if guard.is_none() || needs_spawn {
        if guard.is_some() {
            shutdown_mic_standby();
            guard = MIC.lock().map_err(|_| "lock poisoned")?;
        }
        let mic = MicStandby::new();
        let handle = spawn_mic_thread(&mic);
        mic.thread.lock().map_err(|_| "lock poisoned")?.replace(handle);
        *guard = Some(mic);
    }

    wait_for_mic_ready(guard.as_ref().unwrap())
}

fn wait_for_mic_ready(mic: &MicStandby) -> Result<(), String> {
    if mic.ready.load(Ordering::Relaxed) {
        if let Ok(err_slot) = mic.error.lock() {
            if let Some(err) = err_slot.clone() {
                shutdown_mic_standby();
                return Err(err);
            }
        }
        return Ok(());
    }

    for _ in 0..80 {
        if mic.ready.load(Ordering::Relaxed) {
            if let Ok(err_slot) = mic.error.lock() {
                if let Some(err) = err_slot.clone() {
                    shutdown_mic_standby();
                    return Err(err);
                }
            }
            return Ok(());
        }
        if let Ok(err_slot) = mic.error.lock() {
            if let Some(err) = err_slot.clone() {
                shutdown_mic_standby();
                return Err(err);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    shutdown_mic_standby();
    Err(format!(
        "microphone took too long to start — {hint}",
        hint = mic_permission_hint()
    ))
}

fn spawn_mic_thread(mic: &MicStandby) -> JoinHandle<()> {
    let shutdown = mic.shutdown.clone();
    let capturing = mic.capturing.clone();
    let samples = mic.samples.clone();
    let preroll = mic.preroll.clone();
    let preroll_cap = mic.preroll_cap.clone();
    let sample_rate = mic.sample_rate.clone();
    let ready = mic.ready.clone();
    let error = mic.error.clone();
    let error_report = mic.error.clone();
    let device_name = mic.device_name.clone();

    std::thread::spawn(move || {
        if let Err(e) = run_mic_thread(
            shutdown,
            capturing,
            samples,
            preroll,
            preroll_cap,
            sample_rate,
            ready,
            error,
            device_name,
        ) {
            if let Ok(mut err_slot) = error_report.lock() {
                if err_slot.is_none() {
                    *err_slot = Some(e);
                }
            }
        }
    })
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

        let ctx = match WhisperContext::new_with_params(model_path, ctx_params) {
            Ok(ctx) => ctx,
            Err(gpu_err) => {
                eprintln!("Whisper GPU init failed ({gpu_err}), falling back to CPU");
                let mut cpu_params = WhisperContextParameters::default();
                cpu_params.use_gpu(false);
                WhisperContext::new_with_params(model_path, cpu_params).map_err(|e| {
                    format!("failed to load model (GPU: {gpu_err}; CPU: {e})")
                })?
            }
        };
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
pub fn preload_model(app: &AppHandle, model_path: String) -> Result<(), String> {
    let resolved = resolve_model_path(app, &model_path)?;
    with_cached_context(&resolved, |_| Ok(()))
}

fn run_recording_thread(
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: Arc<Mutex<u32>>,
    ready: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    device_name_out: Arc<Mutex<String>>,
) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or(default_input_hint())?;

    let device_name = device
        .name()
        .unwrap_or_else(|_| "unknown microphone".to_string());
    *device_name_out.lock().unwrap() = device_name.clone();

    let (stream_config, sample_format, rate) = pick_input_config(&device)
        .map_err(|e| format!("{e} (device: {device_name})"))?;
    *sample_rate.lock().unwrap() = rate;

    let buf = samples.clone();
    let err_fn = {
        let error = error.clone();
        let device_name = device_name.clone();
        move |e| {
            let msg = format!("Microphone stream error ({device_name}): {e}");
            eprintln!("{msg}");
            if let Ok(mut guard) = error.lock() {
                *guard = Some(msg);
            }
        }
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                push_mono_samples(&buf, data, stream_config.channels as usize, |s| s);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::F64 => device.build_input_stream(
            &stream_config,
            move |data: &[f64], _: &cpal::InputCallbackInfo| {
                push_mono_samples(&buf, data, stream_config.channels as usize, |s| s as f32);
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
            return Err(format!(
                "Unsupported microphone format ({other:?}) on device: {device_name}"
            ));
        }
    }
    .map_err(|e| format!("Could not open microphone ({device_name}): {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Could not start microphone ({device_name}): {e}"))?;

    ready.store(true, Ordering::Relaxed);

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    drop(stream);
    Ok(())
}

fn run_mic_thread(
    shutdown: Arc<AtomicBool>,
    capturing: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    preroll: Arc<Mutex<Vec<f32>>>,
    preroll_cap: Arc<Mutex<usize>>,
    sample_rate: Arc<Mutex<u32>>,
    ready: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    device_name_out: Arc<Mutex<String>>,
) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or(default_input_hint())?;

    let device_name = device
        .name()
        .unwrap_or_else(|_| "unknown microphone".to_string());
    *device_name_out.lock().unwrap() = device_name.clone();

    let (stream_config, sample_format, rate) = pick_input_config(&device)
        .map_err(|e| format!("{e} (device: {device_name})"))?;
    *sample_rate.lock().unwrap() = rate;
    *preroll_cap.lock().unwrap() = rate as usize * PRE_ROLL_MS as usize / 1000;

    let samples_cb = samples.clone();
    let preroll_cb = preroll.clone();
    let preroll_cap_cb = preroll_cap.clone();
    let capturing_cb = capturing.clone();

    let err_fn = {
        let error = error.clone();
        let device_name = device_name.clone();
        move |e| {
            let msg = format!("Microphone stream error ({device_name}): {e}");
            eprintln!("{msg}");
            if let Ok(mut guard) = error.lock() {
                *guard = Some(msg);
            }
        }
    };

    let channels = stream_config.channels as usize;
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                push_mono_with_preroll(
                    &samples_cb,
                    &preroll_cb,
                    &preroll_cap_cb,
                    &capturing_cb,
                    data,
                    channels,
                    |s| s,
                );
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::F64 => device.build_input_stream(
            &stream_config,
            move |data: &[f64], _: &cpal::InputCallbackInfo| {
                push_mono_with_preroll(
                    &samples_cb,
                    &preroll_cb,
                    &preroll_cap_cb,
                    &capturing_cb,
                    data,
                    channels,
                    |s| s as f32,
                );
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                push_mono_with_preroll(
                    &samples_cb,
                    &preroll_cb,
                    &preroll_cap_cb,
                    &capturing_cb,
                    data,
                    channels,
                    |s| s as f32 / 32768.0,
                );
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            &stream_config,
            move |data: &[i32], _: &cpal::InputCallbackInfo| {
                push_mono_with_preroll(
                    &samples_cb,
                    &preroll_cb,
                    &preroll_cap_cb,
                    &capturing_cb,
                    data,
                    channels,
                    |s| (s as f64 / i32::MAX as f64) as f32,
                );
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                push_mono_with_preroll(
                    &samples_cb,
                    &preroll_cb,
                    &preroll_cap_cb,
                    &capturing_cb,
                    data,
                    channels,
                    |s| (s as f32 / 32768.0) - 1.0,
                );
            },
            err_fn,
            None,
        ),
        other => {
            return Err(format!(
                "Unsupported microphone format ({other:?}) on device: {device_name}"
            ));
        }
    }
    .map_err(|e| format!("Could not open microphone ({device_name}): {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Could not start microphone ({device_name}): {e}"))?;

    ready.store(true, Ordering::Relaxed);

    while !shutdown.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    drop(stream);
    Ok(())
}

fn pick_input_config(
    device: &cpal::Device,
) -> Result<(cpal::StreamConfig, cpal::SampleFormat, u32), String> {
    use cpal::traits::DeviceTrait;

    // Prefer the device default — most reliable on Windows WASAPI.
    if let Ok(default) = device.default_input_config() {
        let rate = default.sample_rate().0;
        let stream_config: cpal::StreamConfig = default.clone().into();
        return Ok((stream_config, default.sample_format(), rate));
    }

    let supported: Vec<_> = device
        .supported_input_configs()
        .map_err(|e| format!("Could not query microphone: {e}"))?
        .collect();

    for &target_rate in &[48_000, 44_100, 24_000, TARGET_SAMPLE_RATE] {
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

fn push_mono_with_preroll<T, F>(
    samples: &Arc<Mutex<Vec<f32>>>,
    preroll: &Arc<Mutex<Vec<f32>>>,
    preroll_cap: &Arc<Mutex<usize>>,
    capturing: &Arc<AtomicBool>,
    data: &[T],
    channels: usize,
    convert: F,
) where
    F: Fn(T) -> f32 + Copy,
    T: Copy,
{
    let channels = channels.max(1);
    let cap = *preroll_cap.lock().unwrap();
    let recording = capturing.load(Ordering::Relaxed);

    let mut pre = preroll.lock().unwrap();
    let mut out = if recording {
        Some(samples.lock().unwrap())
    } else {
        None
    };

    for frame in data.chunks(channels) {
        let mono = frame.iter().map(|&s| convert(s)).sum::<f32>() / channels as f32;
        pre.push(mono);
        if cap > 0 && pre.len() > cap {
            let drop_n = pre.len() - cap;
            pre.drain(0..drop_n);
        }
        if let Some(buf) = out.as_mut() {
            buf.push(mono);
        }
    }
}

pub fn resolve_model_path(app: &AppHandle, configured: &str) -> Result<String, String> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let configured_path = Path::new(configured);
        if configured_path.exists() {
            return Ok(configured.to_string());
        }
    }

    // Bundled with the installer (see tauri.conf.json bundle.resources).
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_dirs = [
            resource_dir.join("models"),
            resource_dir.join("resources").join("models"),
        ];
        for dir in bundled_dirs {
            let bundled = dir.join(BUNDLED_MODEL_FILE);
            if bundled.exists() {
                return Ok(bundled.to_string_lossy().into_owned());
            }
            for name in MODEL_FALLBACK_ORDER {
                let candidate = dir.join(name);
                if candidate.exists() {
                    return Ok(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }

    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if !configured.is_empty() {
        if let Some(parent) = Path::new(configured).parent() {
            search_dirs.push(parent.to_path_buf());
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        search_dirs.push(resource_dir.join("models"));
        search_dirs.push(resource_dir.join("resources").join("models"));
    }

    if let Ok(cwd) = std::env::current_dir() {
        search_dirs.push(cwd.join("models"));
        search_dirs.push(cwd.join("tangent").join("models"));
        search_dirs.push(cwd.join("src-tauri").join("resources").join("models"));
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
        "Whisper model not found. Reinstall Tangent or set a custom model path in Settings (e.g. ggml-small.en.bin)."
    ))
}

fn resample_to_16k(input: &[f32], in_rate: u32) -> Vec<f32> {
    if in_rate == TARGET_SAMPLE_RATE || input.is_empty() {
        return input.to_vec();
    }
    let ratio = in_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let out_len = (input.len() as f64 / ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        out.push(cubic_sample(input, src));
    }
    out
}

/// Catmull-Rom cubic interpolation — sharper than linear, no extra dependencies.
fn cubic_sample(samples: &[f32], pos: f64) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    if samples.len() == 1 {
        return samples[0];
    }

    let idx = pos.floor() as isize;
    let frac = (pos - idx as f64) as f32;
    let at = |i: isize| -> f32 {
        if i < 0 {
            samples[0]
        } else {
            let u = i as usize;
            samples.get(u).copied().unwrap_or(*samples.last().unwrap())
        }
    };

    let s0 = at(idx - 1);
    let s1 = at(idx);
    let s2 = at(idx + 1);
    let s3 = at(idx + 2);

    let a = -0.5 * s0 + 1.5 * s1 - 1.5 * s2 + 0.5 * s3;
    let b = s0 - 2.5 * s1 + 2.0 * s2 - 0.5 * s3;
    let c = -0.5 * s0 + 0.5 * s2;
    let d = s1;
    a * frac * frac * frac + b * frac * frac + c * frac + d
}

/// Trim leading/trailing silence and normalize level for Whisper.
fn preprocess_pcm(pcm: &mut Vec<f32>) {
    remove_dc_offset(pcm);
    highpass_filter(pcm, TARGET_SAMPLE_RATE, 80.0);

    let noise_floor = estimate_noise_floor(pcm);
    let threshold = (noise_floor * 2.8).clamp(0.003, 0.018);
    trim_silence(pcm, threshold);
    if pcm.is_empty() {
        return;
    }

    normalize_for_whisper(pcm);
}

fn remove_dc_offset(pcm: &mut [f32]) {
    if pcm.is_empty() {
        return;
    }
    let mean = pcm.iter().sum::<f32>() / pcm.len() as f32;
    for sample in pcm.iter_mut() {
        *sample -= mean;
    }
}

/// One-pole high-pass to remove rumble / HVAC without touching speech fundamentals.
fn highpass_filter(pcm: &mut [f32], sample_rate: u32, cutoff_hz: f32) {
    if pcm.len() < 2 {
        return;
    }
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_hz);
    let dt = 1.0 / sample_rate as f32;
    let alpha = rc / (rc + dt);
    let mut prev_in = pcm[0];
    let mut prev_out = 0.0f32;
    for sample in pcm.iter_mut() {
        let x = *sample;
        let y = alpha * (prev_out + x - prev_in);
        prev_in = x;
        prev_out = y;
        *sample = y;
    }
}

fn estimate_noise_floor(pcm: &[f32]) -> f32 {
    const WINDOW: usize = 320;
    if pcm.len() < WINDOW {
        return 0.006;
    }

    let mut rms_windows: Vec<f32> = Vec::new();
    let mut i = 0;
    while i + WINDOW <= pcm.len() {
        let rms = (pcm[i..i + WINDOW]
            .iter()
            .map(|s| s * s)
            .sum::<f32>()
            / WINDOW as f32)
            .sqrt();
        rms_windows.push(rms);
        i += WINDOW / 2;
    }
    if rms_windows.is_empty() {
        return 0.006;
    }
    rms_windows.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = (rms_windows.len() as f32 * 0.2).floor() as usize;
    rms_windows[idx.min(rms_windows.len() - 1)].max(0.001)
}

fn normalize_for_whisper(pcm: &mut [f32]) {
    if pcm.is_empty() {
        return;
    }
    let rms = (pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len() as f32).sqrt();
    let peak = pcm.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    if rms < 1e-6 || peak < 1e-6 {
        return;
    }

    // Target RMS with a peak limiter so quiet speech is boosted without clipping noise spikes.
    let rms_gain = 0.14 / rms;
    let peak_gain = 0.92 / peak;
    let gain = rms_gain.min(peak_gain).clamp(0.25, 8.0);
    for sample in pcm.iter_mut() {
        *sample = (*sample * gain).clamp(-0.99, 0.99);
    }
}

fn trim_silence(pcm: &mut Vec<f32>, threshold: f32) {
    if pcm.is_empty() {
        return;
    }

    const WINDOW: usize = 320; // 20 ms at 16 kHz
    const TAIL_PAD: usize = 480; // 30 ms at end only

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

    // Keep the start intact — pre-roll already captured speech before "Listening".
    let mut end = pcm.len();
    while end > WINDOW && is_silent(end - WINDOW) {
        end -= WINDOW / 2;
    }

    end = (end + TAIL_PAD).min(pcm.len());

    if end < pcm.len() {
        *pcm = pcm[..end].to_vec();
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
        params.set_single_segment(false);
        params.set_no_context(true);
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
                    let part = s.trim();
                    if part.is_empty() {
                        continue;
                    }
                    if !text.is_empty() && !text.ends_with(' ') {
                        text.push(' ');
                    }
                    text.push_str(part);
                }
            }
        }
        Ok(text.trim().to_string())
    })
}
