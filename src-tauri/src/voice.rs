//! On-device voice capture + transcription (optional, behind the `voice` feature).
//!
//! cpal's Stream is not Send on Windows, so the stream is owned entirely by a
//! dedicated recording thread. We communicate only via Arc-shared buffers and an
//! atomic stop flag - nothing that isn't Send/Sync crosses a thread boundary.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

struct Session {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: Arc<Mutex<u32>>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

pub fn start_recording() -> Result<(), String> {
    let mut guard = SESSION.lock().map_err(|_| "lock poisoned")?;
    if guard.is_some() {
        return Err("already recording".into());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let sample_rate = Arc::new(Mutex::new(16_000u32));

    let stop_t = stop.clone();
    let samples_t = samples.clone();
    let sr_t = sample_rate.clone();

    let handle = std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            return;
        };
        let Ok(config) = device.default_input_config() else {
            return;
        };
        *sr_t.lock().unwrap() = config.sample_rate().0;
        let channels = config.channels() as usize;
        let sample_format = config.sample_format();
        let stream_config: cpal::StreamConfig = config.into();

        let buf = samples_t.clone();
        let err_fn = |_e| {};

        // MVP: handle the common f32 input format. Other formats fall back to no-op.
        let stream = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mut out = buf.lock().unwrap();
                    for frame in data.chunks(channels.max(1)) {
                        let mono = frame.iter().copied().sum::<f32>() / channels.max(1) as f32;
                        out.push(mono);
                    }
                },
                err_fn,
                None,
            ),
            _ => return,
        };

        let Ok(stream) = stream else {
            return;
        };
        if stream.play().is_err() {
            return;
        }
        while !stop_t.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        drop(stream);
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

    let pcm = resample_to_16k(&samples, in_rate);
    transcribe_pcm(&pcm, &model_path)
}

/// Cheap linear resample to whisper's required 16 kHz mono.
fn resample_to_16k(input: &[f32], in_rate: u32) -> Vec<f32> {
    if in_rate == 16_000 || input.is_empty() {
        return input.to_vec();
    }
    let ratio = 16_000f32 / in_rate as f32;
    let out_len = (input.len() as f32 * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f32 / ratio;
        let idx = src as usize;
        let frac = src - idx as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

fn transcribe_pcm(pcm: &[f32], model_path: &str) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    if !std::path::Path::new(model_path).exists() {
        return Err(format!(
            "Whisper model not found at '{model_path}'. Download e.g. ggml-base.en.bin."
        ));
    }

    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("failed to load model: {e}"))?;
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("failed to create state: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_progress(false);
    params.set_print_special(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_language(Some("en"));

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
}
