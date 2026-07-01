//! Google OAuth (PKCE + loopback) and Calendar API event creation.

use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const SCOPE: &str = "https://www.googleapis.com/auth/calendar openid email";
const FULL_CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar";
const SCOPE_SETUP_HINT: &str = "In Google Cloud Console → OAuth consent screen → Scopes, add \
    \".../auth/calendar\" (Google Calendar API — full access), save, then Disconnect and \
    Connect again in Tangent Settings.";
const CALENDARS_URL: &str = "https://www.googleapis.com/calendar/v3/calendars";
const CALENDAR_LIST_URL: &str = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CHECKIN_CALENDAR_NAME: &str = "Tangent Reminders";
const CHECKIN_EVENT_SUMMARY: &str = "Check Tangent";

fn checkin_event_reminders() -> serde_json::Value {
    serde_json::json!({
        "useDefault": false,
        "overrides": [
            { "method": "popup", "minutes": 0 }
        ]
    })
}
const CALENDAR_EVENTS_URL: &str =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events";

fn calendar_events_url(calendar_id: &str) -> String {
    format!(
        "{CALENDARS_URL}/{}/events",
        urlencoding::encode(calendar_id)
    )
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GoogleTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix timestamp (seconds) when the access token expires.
    pub expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleOAuthResult {
    pub email: String,
    pub tokens: GoogleTokens,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEventParams {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub tokens: GoogleTokens,
    pub summary: String,
    pub description: String,
    /// Local datetime, e.g. `2026-06-25T18:00:00`
    pub start_local: String,
    pub end_local: String,
    pub timezone: String,
    /// Popup reminder offsets in minutes before the event start.
    #[serde(default)]
    pub reminder_minutes: Vec<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEventResult {
    pub html_link: String,
    pub tokens: GoogleTokens,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenInfo {
    scope: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CalendarEventResponse {
    id: Option<String>,
    html_link: Option<String>,
}

fn unix_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64
}

fn pkce_pair() -> (String, String) {
    const CHARSET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    let verifier: String = (0..64)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect();
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        digest,
    );
    (verifier, challenge)
}

async fn wait_for_auth_code(listener: tokio::net::TcpListener) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let timeout = Duration::from_secs(300);
    let accept = tokio::time::timeout(timeout, listener.accept())
        .await
        .map_err(|_| "Sign-in timed out. Try again.".to_string())?
        .map_err(|e| e.to_string())?;
    let (mut stream, _) = accept;

    let mut buf = vec![0u8; 8192];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Could not read OAuth callback: {e}"))?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first_line = req.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");
    let query = path.split('?').nth(1).unwrap_or("");

    let mut code: Option<String> = None;
    let mut oauth_error: Option<String> = None;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        let key = kv.next().unwrap_or("");
        let value = kv
            .next()
            .map(|s| urlencoding::decode(s).unwrap_or_default().into_owned())
            .unwrap_or_default();
        match key {
            "code" => code = Some(value),
            "error" => oauth_error = Some(value),
            _ => {}
        }
    }

    let body = if code.is_some() {
        "<html><body style=\"font-family:system-ui,sans-serif;padding:2rem\"><h2>Tangent</h2><p>Google Calendar connected. You can close this tab.</p></body></html>"
    } else {
        "<html><body style=\"font-family:system-ui,sans-serif;padding:2rem\"><h2>Tangent</h2><p>Sign-in was cancelled or failed. Return to the app and try again.</p></body></html>"
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;

    if let Some(err) = oauth_error {
        return Err(format!("Google sign-in failed: {err}"));
    }
    code.ok_or_else(|| "No authorization code received".to_string())
}

async fn exchange_code(
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<GoogleTokens, String> {
    let client = reqwest::Client::new();
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", client_id),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier),
    ];
    let secret_owned;
    if let Some(secret) = client_secret.filter(|s| !s.trim().is_empty()) {
        secret_owned = secret.to_string();
        form.push(("client_secret", &secret_owned));
    }

    let resp = client
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {e}"))?;

    let status = resp.status();
    let body: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid token response: {e}"))?;

    if let Some(err) = body.error {
        let detail = body.error_description.unwrap_or_default();
        return Err(format!("Token exchange failed ({status}): {err} {detail}"));
    }

    let expires_in = body.expires_in.unwrap_or(3600);
    Ok(GoogleTokens {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: unix_now_secs() + expires_in,
    })
}

pub async fn refresh_access_token(
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<GoogleTokens, String> {
    let client = reqwest::Client::new();
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", client_id),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];
    let secret_owned;
    if let Some(secret) = client_secret.filter(|s| !s.trim().is_empty()) {
        secret_owned = secret.to_string();
        form.push(("client_secret", &secret_owned));
    }

    let resp = client
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Token refresh failed: {e}"))?;

    let body: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid refresh response: {e}"))?;

    if let Some(err) = body.error {
        let detail = body.error_description.unwrap_or_default();
        return Err(format!("Token refresh failed: {err} {detail}"));
    }

    let expires_in = body.expires_in.unwrap_or(3600);
    Ok(GoogleTokens {
        access_token: body.access_token,
        refresh_token: body.refresh_token.or_else(|| Some(refresh_token.to_string())),
        expires_at: unix_now_secs() + expires_in,
    })
}

async fn token_scopes(access_token: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://oauth2.googleapis.com/tokeninfo?access_token={}",
        urlencoding::encode(access_token)
    );
    let info: TokenInfo = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Could not verify Google permissions: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid token info response: {e}"))?;

    if let Some(err) = info.error {
        return Err(format!("Could not verify Google permissions: {err}"));
    }

    Ok(info
        .scope
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .collect())
}

fn scopes_include_full_calendar(scopes: &[String]) -> bool {
    scopes.iter().any(|s| s == FULL_CALENDAR_SCOPE)
}

fn insufficient_scope_error(granted: &[String]) -> String {
    format!(
        "Google granted insufficient scopes ({}). Phone reminders need full calendar access. {}",
        granted.join(", "),
        SCOPE_SETUP_HINT
    )
}

async fn require_full_calendar_scope(access_token: &str) -> Result<(), String> {
    let scopes = token_scopes(access_token).await?;
    if scopes_include_full_calendar(&scopes) {
        Ok(())
    } else {
        Err(insufficient_scope_error(&scopes))
    }
}

pub async fn revoke_refresh_token(refresh_token: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    client
        .post("https://oauth2.googleapis.com/revoke")
        .form(&[("token", refresh_token)])
        .send()
        .await
        .map_err(|e| format!("Could not revoke Google session: {e}"))?;
    Ok(())
}

async fn user_email(access_token: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let info: UserInfo = client
        .get(USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Could not fetch Google account: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid user info response: {e}"))?;

    info.email
        .ok_or_else(|| "Google account has no email on file".to_string())
}

async fn ensure_fresh_tokens(
    client_id: &str,
    client_secret: Option<&str>,
    tokens: &GoogleTokens,
) -> Result<GoogleTokens, String> {
    let skew = 60;
    if tokens.expires_at > unix_now_secs() + skew {
        return Ok(tokens.clone());
    }
    let refresh = tokens
        .refresh_token
        .as_deref()
        .ok_or_else(|| "Google session expired. Connect again in Settings.".to_string())?;
    refresh_access_token(client_id, client_secret, refresh).await
}

pub async fn oauth_connect(
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<GoogleOAuthResult, String> {
    if client_id.trim().is_empty() {
        return Err("Google Client ID is required. Add it in Settings first.".into());
    }

    let (verifier, challenge) = pkce_pair();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not start local server for sign-in: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth/callback");

    let auth_url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        urlencoding::encode(client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(SCOPE),
        urlencoding::encode(&challenge),
    );

    open::that(&auth_url).map_err(|e| format!("Could not open browser: {e}"))?;
    let code = wait_for_auth_code(listener).await?;
    let tokens = exchange_code(
        client_id,
        client_secret,
        &code,
        &redirect_uri,
        &verifier,
    )
    .await?;

    if tokens.refresh_token.is_none() {
        return Err(
            "Google did not issue a refresh token. Disconnect, remove Tangent at \
             myaccount.google.com/permissions, then connect again."
                .into(),
        );
    }

    require_full_calendar_scope(&tokens.access_token).await?;

    let email = user_email(&tokens.access_token).await?;
    Ok(GoogleOAuthResult { email, tokens })
}

pub async fn create_calendar_event(params: CreateEventParams) -> Result<CreateEventResult, String> {
    if params.client_id.trim().is_empty() {
        return Err("Google Client ID is required.".into());
    }

    let client_secret = params.client_secret.as_deref();
    let tokens = ensure_fresh_tokens(
        &params.client_id,
        client_secret,
        &params.tokens,
    )
    .await?;

    let mut body = serde_json::json!({
        "summary": params.summary,
        "description": params.description,
        "start": {
            "dateTime": params.start_local,
            "timeZone": params.timezone,
        },
        "end": {
            "dateTime": params.end_local,
            "timeZone": params.timezone,
        },
    });

    if !params.reminder_minutes.is_empty() {
        let overrides: Vec<serde_json::Value> = params
            .reminder_minutes
            .iter()
            .map(|m| serde_json::json!({ "method": "popup", "minutes": m }))
            .collect();
        body["reminders"] = serde_json::json!({
            "useDefault": false,
            "overrides": overrides,
        });
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(CALENDAR_EVENTS_URL)
        .bearer_auth(&tokens.access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Calendar API request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(format!("Calendar API error ({status}): {err_body}"));
    }

    let created: CalendarEventResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid calendar response: {e}"))?;

    let html_link = created
        .html_link
        .unwrap_or_else(|| "https://calendar.google.com/".to_string());

    Ok(CreateEventResult {
        html_link,
        tokens,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInSlotParams {
    pub start_local: String,
    pub end_local: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCheckInParams {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub tokens: GoogleTokens,
    pub enabled: bool,
    pub existing_event_id: Option<String>,
    pub existing_event_ids: Option<Vec<String>>,
    pub rrule: Option<String>,
    pub rrules: Option<Vec<String>>,
    pub start_local: Option<String>,
    pub end_local: Option<String>,
    pub check_in_slots: Option<Vec<CheckInSlotParams>>,
    pub timezone: String,
    pub check_in_calendar_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCheckInResult {
    pub event_id: Option<String>,
    pub event_ids: Option<Vec<String>>,
    pub check_in_calendar_id: Option<String>,
    pub tokens: GoogleTokens,
}

#[derive(Debug, Deserialize)]
struct CalendarMeta {
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CalendarListResponse {
    items: Option<Vec<CalendarListEntry>>,
}

#[derive(Debug, Deserialize)]
struct CalendarListEntry {
    id: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleApiErrorBody {
    error: Option<GoogleApiErrorDetail>,
}

#[derive(Debug, Deserialize)]
struct GoogleApiErrorDetail {
    message: Option<String>,
}

async fn find_checkin_calendar_by_name(access_token: &str) -> Result<Option<String>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://www.googleapis.com/calendar/v3/users/me/calendarList")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let list: CalendarListResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(list
        .items
        .unwrap_or_default()
        .into_iter()
        .find(|e| e.summary.as_deref() == Some(CHECKIN_CALENDAR_NAME))
        .and_then(|e| e.id))
}

async fn ensure_checkin_calendar(
    access_token: &str,
    existing_id: Option<&str>,
    timezone: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    if let Some(id) = existing_id.filter(|s| !s.is_empty()) {
        let url = format!("{CALENDARS_URL}/{}", urlencoding::encode(id));
        let resp = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            return Ok(id.to_string());
        }
    }

    if let Some(id) = find_checkin_calendar_by_name(access_token).await? {
        return Ok(id);
    }

    let body = serde_json::json!({
        "summary": CHECKIN_CALENDAR_NAME,
        "description": "Tangent check-in reminders. Hide this calendar in Google Calendar to keep your main view clean — enable notifications for this calendar on your phone.",
        "timeZone": timezone,
        "defaultReminders": [
            { "method": "popup", "minutes": 0 }
        ],
    });
    let resp = client
        .post(CALENDARS_URL)
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not create Tangent Reminders calendar: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        let detail = serde_json::from_str::<GoogleApiErrorBody>(&text)
            .ok()
            .and_then(|e| e.error)
            .and_then(|e| e.message)
            .unwrap_or(text);
        let hint = if status.as_u16() == 403 {
            format!(" {SCOPE_SETUP_HINT}")
        } else {
            String::new()
        };
        return Err(format!(
            "Could not create Tangent Reminders calendar ({status}): {detail}.{hint}"
        ));
    }

    let created: CalendarMeta = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid calendar create response: {e}"))?;

    created.id.ok_or_else(|| {
        format!("Google did not return a calendar id. Response: {text}")
    })
}

/// Ensure the Tangent Reminders calendar has popup defaults so Android/iOS actually alert.
async fn configure_checkin_calendar(access_token: &str, calendar_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let reminders = serde_json::json!([{ "method": "popup", "minutes": 0 }]);

    let cal_url = format!("{CALENDARS_URL}/{}", urlencoding::encode(calendar_id));
    let _ = client
        .patch(&cal_url)
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "defaultReminders": reminders }))
        .send()
        .await;

    let list_url = format!("{CALENDAR_LIST_URL}/{}", urlencoding::encode(calendar_id));
    let get_resp = client
        .get(&list_url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if get_resp.status().is_success() {
        let mut entry: serde_json::Value = get_resp.json().await.map_err(|e| e.to_string())?;
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("defaultReminders".to_string(), reminders.clone());
            obj.insert("selected".to_string(), serde_json::Value::Bool(true));
            obj.insert("hidden".to_string(), serde_json::Value::Bool(false));
        }
        let _ = client
            .put(&list_url)
            .bearer_auth(access_token)
            .json(&entry)
            .send()
            .await;
    } else if get_resp.status().as_u16() == 404 {
        let insert_body = serde_json::json!({
            "id": calendar_id,
            "defaultReminders": reminders,
            "selected": true,
            "hidden": false,
        });
        let _ = client
            .post(CALENDAR_LIST_URL)
            .bearer_auth(access_token)
            .json(&insert_body)
            .send()
            .await;
    }

    Ok(())
}

async fn ensure_checkin_calendar_configured(
    access_token: &str,
    existing_id: Option<&str>,
    timezone: &str,
) -> Result<String, String> {
    let calendar_id = ensure_checkin_calendar(access_token, existing_id, timezone).await?;
    configure_checkin_calendar(access_token, &calendar_id).await?;
    Ok(calendar_id)
}

#[derive(Debug, Deserialize)]
struct CalendarEventListEntry {
    id: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventListResponse {
    items: Option<Vec<CalendarEventListEntry>>,
    next_page_token: Option<String>,
}

async fn delete_checkin_events_on_calendar(
    access_token: &str,
    calendar_id: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut url = format!(
            "{}?q={}&singleEvents=false&maxResults=250",
            calendar_events_url(calendar_id),
            urlencoding::encode(CHECKIN_EVENT_SUMMARY),
        );
        if let Some(token) = &page_token {
            url.push_str(&format!("&pageToken={}", urlencoding::encode(token)));
        }

        let resp = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Ok(());
        }

        let list: EventListResponse = resp.json().await.map_err(|e| e.to_string())?;
        for item in list.items.unwrap_or_default() {
            if item.summary.as_deref() == Some(CHECKIN_EVENT_SUMMARY) {
                if let Some(id) = item.id {
                    let _ = delete_calendar_event(access_token, calendar_id, &id).await;
                }
            }
        }

        page_token = list.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    Ok(())
}

/// Remove every Tangent check-in series (stored id, search hits, legacy primary).
async fn purge_all_checkin_events(
    access_token: &str,
    check_in_calendar_id: Option<&str>,
    stored_event_id: Option<&str>,
    stored_event_ids: Option<&[String]>,
) -> Result<(), String> {
    let mut deleted: std::collections::HashSet<String> = std::collections::HashSet::new();

    if let Some(ids) = stored_event_ids {
        for id in ids {
            if id.is_empty() || !deleted.insert(id.clone()) {
                continue;
            }
            if let Some(cal) = check_in_calendar_id.filter(|s| !s.is_empty()) {
                let _ = delete_calendar_event(access_token, cal, id).await;
            }
            let _ = delete_calendar_event(access_token, "primary", id).await;
        }
    }

    if let Some(id) = stored_event_id.filter(|s| !s.is_empty()) {
        if deleted.insert(id.to_string()) {
            if let Some(cal) = check_in_calendar_id.filter(|s| !s.is_empty()) {
                let _ = delete_calendar_event(access_token, cal, id).await;
            }
            let _ = delete_calendar_event(access_token, "primary", id).await;
        }
    }

    let mut calendar_ids: Vec<String> = Vec::new();
    if let Some(id) = check_in_calendar_id.filter(|s| !s.is_empty()) {
        calendar_ids.push(id.to_string());
    }
    if let Some(id) = find_checkin_calendar_by_name(access_token).await? {
        if !calendar_ids.iter().any(|c| c == &id) {
            calendar_ids.push(id);
        }
    }
    if !calendar_ids.iter().any(|c| c == "primary") {
        calendar_ids.push("primary".to_string());
    }

    for cal_id in calendar_ids {
        delete_checkin_events_on_calendar(access_token, &cal_id).await?;
    }

    Ok(())
}

async fn delete_calendar_event(
    access_token: &str,
    calendar_id: &str,
    event_id: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/{}",
        calendar_events_url(calendar_id),
        urlencoding::encode(event_id)
    );
    let client = reqwest::Client::new();
    let resp = client
        .delete(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Calendar delete failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() && status.as_u16() != 404 {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(format!("Calendar delete error ({status}): {err_body}"));
    }
    Ok(())
}

pub async fn sync_checkin_event(params: SyncCheckInParams) -> Result<SyncCheckInResult, String> {
    if params.client_id.trim().is_empty() {
        return Err("Google Client ID is required.".into());
    }

    let client_secret = params.client_secret.as_deref();
    let tokens = ensure_fresh_tokens(
        &params.client_id,
        client_secret,
        &params.tokens,
    )
    .await?;

    purge_all_checkin_events(
        &tokens.access_token,
        params.check_in_calendar_id.as_deref(),
        params.existing_event_id.as_deref(),
        params.existing_event_ids.as_deref(),
    )
    .await?;

    if !params.enabled {
        return Ok(SyncCheckInResult {
            event_id: None,
            event_ids: None,
            check_in_calendar_id: params.check_in_calendar_id,
            tokens,
        });
    }

    require_full_calendar_scope(&tokens.access_token).await?;

    let calendar_id = ensure_checkin_calendar_configured(
        &tokens.access_token,
        params.check_in_calendar_id.as_deref(),
        &params.timezone,
    )
    .await?;

    let slots: Vec<CheckInSlotParams> = params
        .check_in_slots
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let start = params.start_local.as_deref().filter(|s| !s.is_empty())?;
            let end = params.end_local.as_deref().filter(|s| !s.is_empty())?;
            Some(vec![CheckInSlotParams {
                start_local: start.to_string(),
                end_local: end.to_string(),
            }])
        })
        .ok_or_else(|| "At least one check-in time is required".to_string())?;

    let client = reqwest::Client::new();
    let mut event_ids: Vec<String> = Vec::new();

    for slot in slots {
        let body = serde_json::json!({
            "summary": CHECKIN_EVENT_SUMMARY,
            "description": "Open Tangent on your desktop and review your thoughts.",
            "start": {
                "dateTime": slot.start_local,
                "timeZone": params.timezone,
            },
            "end": {
                "dateTime": slot.end_local,
                "timeZone": params.timezone,
            },
            "recurrence": ["RRULE:FREQ=DAILY"],
            "reminders": checkin_event_reminders(),
        });

        let resp = client
            .post(calendar_events_url(&calendar_id))
            .bearer_auth(&tokens.access_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Calendar API request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let err_body = resp.text().await.unwrap_or_default();
            return Err(format!("Calendar API error ({status}): {err_body}"));
        }

        let created: CalendarEventResponse = resp
            .json()
            .await
            .map_err(|e| format!("Invalid calendar response: {e}"))?;

        if let Some(id) = created.id {
            event_ids.push(id);
        }
    }

    if event_ids.is_empty() {
        return Err("Google Calendar did not return event ids".into());
    }

    Ok(SyncCheckInResult {
        event_id: event_ids.first().cloned(),
        event_ids: Some(event_ids),
        check_in_calendar_id: Some(calendar_id),
        tokens,
    })
}
