mod context;
mod google_calendar;
#[cfg(feature = "voice")]
mod voice;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Triggered by the global hotkey (registered from the frontend). Reads the
/// work context BEFORE showing the overlay, then shows the capture window and
/// hands it the context.
#[tauri::command]
fn trigger_capture(app: tauri::AppHandle) {
    let ctx = context::capture_context();
    if let Some(win) = app.get_webview_window("capture") {
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit_to("capture", "open-capture", ctx);
    }
}

/// Hides the capture overlay and returns focus to the previously active window.
#[tauri::command]
fn restore_focus(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("capture") {
        let _ = win.hide();
    }
    context::focus_previous();
}

#[tauri::command]
fn open_main(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Active window context for typed capture (no recording).
#[tauri::command]
fn get_work_context() -> context::WorkContext {
    context::capture_context()
}

/// Hold-to-talk: invoked when the global hotkey is PRESSED. Captures the work
/// context, shows the recording HUD (without stealing focus), and starts
/// recording. Returns the context so the frontend can attach it on save.
#[tauri::command]
async fn begin_voice(app: tauri::AppHandle) -> Result<context::WorkContext, String> {
    let ctx = context::capture_context();
    if let Some(win) = app.get_webview_window("capture") {
        let _ = win.center();
        let _ = win.set_always_on_top(true);
        let _ = win.show();
        let _ = app.emit_to("capture", "voice-phase", "warming");
    }
    #[cfg(feature = "voice")]
    {
        voice::start_recording()?;
    }
    if let Some(win) = app.get_webview_window("capture") {
        let _ = win.set_always_on_top(true);
        let _ = app.emit_to("capture", "voice-phase", "listening");
        let _ = app.emit_to("capture", "voice-start", ctx.clone());
    }
    Ok(ctx)
}

/// Hold-to-talk: invoked when the hotkey is RELEASED, after transcription. Hides
/// the HUD and returns focus to the window the user was in.
#[tauri::command]
fn end_voice(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("capture") {
        let _ = win.hide();
    }
    context::focus_previous();
}

// --- Voice command wrappers. Always present so the JS invoke handler is stable;
// the actual body is gated behind the optional `voice` build feature.
#[tauri::command]
async fn voice_start() -> Result<(), String> {
    #[cfg(feature = "voice")]
    {
        voice::start_recording()
    }
    #[cfg(not(feature = "voice"))]
    {
        Err("voice feature not enabled in this build".into())
    }
}

#[tauri::command]
async fn google_oauth_connect(
    client_id: String,
    client_secret: Option<String>,
) -> Result<google_calendar::GoogleOAuthResult, String> {
    google_calendar::oauth_connect(&client_id, client_secret.as_deref()).await
}

#[tauri::command]
async fn google_oauth_revoke(refresh_token: String) -> Result<(), String> {
    google_calendar::revoke_refresh_token(&refresh_token).await
}

#[tauri::command]
async fn google_calendar_create_event(
    params: google_calendar::CreateEventParams,
) -> Result<google_calendar::CreateEventResult, String> {
    google_calendar::create_calendar_event(params).await
}

#[tauri::command]
async fn google_calendar_delete_event(
    params: google_calendar::DeleteEventParams,
) -> Result<google_calendar::DeleteEventResult, String> {
    google_calendar::delete_task_calendar_event(params).await
}

#[tauri::command]
async fn google_calendar_sync_checkin(
    params: google_calendar::SyncCheckInParams,
) -> Result<google_calendar::SyncCheckInResult, String> {
    google_calendar::sync_checkin_event(params).await
}

#[tauri::command]
fn voice_resolve_model_path(app: tauri::AppHandle, configured: String) -> Result<String, String> {
    #[cfg(feature = "voice")]
    {
        voice::resolve_model_path(&app, &configured)
    }
    #[cfg(not(feature = "voice"))]
    {
        let _ = (app, configured);
        Err("voice feature not enabled in this build".into())
    }
}

#[tauri::command]
fn voice_warm_microphone() -> Result<(), String> {
    #[cfg(feature = "voice")]
    {
        voice::warm_microphone()
    }
    #[cfg(not(feature = "voice"))]
    {
        Ok(())
    }
}

#[tauri::command]
fn voice_preload_model(app: tauri::AppHandle, model_path: String) -> Result<(), String> {
    #[cfg(feature = "voice")]
    {
        voice::preload_model(&app, model_path)
    }
    #[cfg(not(feature = "voice"))]
    {
        let _ = (app, model_path);
        Ok(())
    }
}

#[tauri::command]
async fn voice_test_microphone() -> Result<voice::MicTestResult, String> {
    #[cfg(feature = "voice")]
    {
        let (device, samples) = voice::test_microphone()?;
        Ok(voice::MicTestResult { device, samples })
    }
    #[cfg(not(feature = "voice"))]
    {
        Err("voice feature not enabled in this build".into())
    }
}

#[tauri::command]
async fn voice_stop_transcribe(app: tauri::AppHandle, model_path: String) -> Result<String, String> {
    #[cfg(feature = "voice")]
    {
        voice::stop_and_transcribe(&app, model_path)
    }
    #[cfg(not(feature = "voice"))]
    {
        let _ = (app, model_path);
        Err("voice feature not enabled in this build".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "init schema",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "ctx_extra for rich work context",
            sql: include_str!("../migrations/002_ctx_extra.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "calendar_event_id for task reminders",
            sql: include_str!("../migrations/003_calendar_event.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations("sqlite:tangent.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // --- System tray ---
            let open_i = MenuItem::with_id(app, "open", "Open Tangent", true, None::<&str>)?;
            let triage_i = MenuItem::with_id(app, "triage", "Triage", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &triage_i, &quit_i])?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Tangent — click to open")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "triage" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = app.emit_to("main", "go-triage", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            trigger_capture,
            restore_focus,
            open_main,
            get_work_context,
            begin_voice,
            end_voice,
            google_oauth_connect,
            google_oauth_revoke,
            google_calendar_create_event,
            google_calendar_delete_event,
            google_calendar_sync_checkin,
            voice_resolve_model_path,
            voice_preload_model,
            voice_warm_microphone,
            voice_test_microphone,
            voice_start,
            voice_stop_transcribe
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
