//! Microsoft Graph Calendar (Outlook / Microsoft 365) via PKCE loopback OAuth.

use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AUTH_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPE: &str = "Calendars.ReadWrite offline_access User.Read openid email";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const CHECKIN_CALENDAR_NAME: &str = "Tangent Reminders";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutlookTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookOAuthResult {
    pub email: String,
    pub tokens: OutlookTokens,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookCreateEventParams {
    pub client_id: String,
    pub tokens: OutlookTokens,
    pub summary: String,
    pub description: String,
    pub start_local: String,
    pub end_local: String,
    pub timezone: String,
    #[serde(default)]
    pub reminder_minutes: Vec<i32>,
    pub calendar_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookCreateEventResult {
    pub event_id: Option<String>,
    pub calendar_id: Option<String>,
    pub tokens: OutlookTokens,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookDeleteEventParams {
    pub client_id: String,
    pub tokens: OutlookTokens,
    pub event_id: String,
    pub calendar_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookDeleteEventResult {
    pub tokens: OutlookTokens,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookCheckInSlot {
    pub start_local: String,
    pub end_local: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookSyncCheckInParams {
    pub client_id: String,
    pub tokens: OutlookTokens,
    pub enabled: bool,
    pub existing_event_ids: Option<Vec<String>>,
    pub check_in_slots: Option<Vec<OutlookCheckInSlot>>,
    pub timezone: String,
    pub calendar_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookSyncCheckInResult {
    pub event_ids: Vec<String>,
    pub calendar_id: Option<String>,
    pub tokens: OutlookTokens,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn pkce_pair() -> (String, String) {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
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

fn parse_token_response(raw: &str, status: reqwest::StatusCode, kind: &str) -> Result<OutlookTokens, String> {
    let body: TokenResponse = serde_json::from_str(raw).map_err(|_| {
        let preview: String = raw.chars().take(180).collect();
        format!("Invalid {kind} response ({status}): {preview}")
    })?;
    if let Some(err) = body.error {
        let detail = body.error_description.unwrap_or_default();
        return Err(format!("{kind} failed: {err} {detail}"));
    }
    let access = body
        .access_token
        .ok_or_else(|| format!("{kind} did not return an access token"))?;
    Ok(OutlookTokens {
        access_token: access,
        refresh_token: body.refresh_token,
        expires_at: now_secs() + body.expires_in.unwrap_or(3600) - 60,
    })
}

async fn wait_for_auth_code(listener: tokio::net::TcpListener) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("Sign-in timed out. Try again.".into());
        }
        let (mut stream, _) = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| "Sign-in timed out. Try again.".to_string())?
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| format!("Could not read OAuth callback: {e}"))?;
        let req = String::from_utf8_lossy(&buf[..n]);
        let first_line = req.lines().next().unwrap_or("");
        let path = first_line.split_whitespace().nth(1).unwrap_or("");
        let query = path.split('?').nth(1).unwrap_or("");
        let mut code = None;
        let mut oauth_error = None;
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
            "<html><body style=\"font-family:system-ui;padding:2rem\"><h2>Tangent</h2><p>Outlook connected. You can close this tab.</p></body></html>"
        } else {
            "<html><body style=\"font-family:system-ui;padding:2rem\"><h2>Tangent</h2><p>Waiting for Outlook sign-in…</p></body></html>"
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes()).await;
        if let Some(err) = oauth_error {
            return Err(format!("Outlook sign-in failed: {err}"));
        }
        if let Some(c) = code.filter(|s| !s.is_empty()) {
            return Ok(c);
        }
    }
}

async fn exchange_code(
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<OutlookTokens, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
            ("scope", SCOPE),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {e}"))?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    parse_token_response(&raw, status, "Token exchange")
}

async fn refresh_access_token(client_id: &str, refresh_token: &str) -> Result<OutlookTokens, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
            ("scope", SCOPE),
        ])
        .send()
        .await
        .map_err(|e| format!("Token refresh failed: {e}"))?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    let mut tokens = parse_token_response(&raw, status, "Token refresh")?;
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token.to_string());
    }
    Ok(tokens)
}

async fn ensure_fresh_tokens(client_id: &str, tokens: &OutlookTokens) -> Result<OutlookTokens, String> {
    if tokens.expires_at > now_secs() + 30 {
        return Ok(tokens.clone());
    }
    let refresh = tokens
        .refresh_token
        .as_deref()
        .ok_or_else(|| "Outlook session expired. Connect again in Settings.".to_string())?;
    refresh_access_token(client_id, refresh).await
}

async fn user_email(access_token: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Me {
        mail: Option<String>,
        user_principal_name: Option<String>,
    }
    let client = reqwest::Client::new();
    let me: Me = client
        .get(format!("{GRAPH}/me"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Could not fetch Outlook account: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid Outlook profile: {e}"))?;
    me.mail
        .or(me.user_principal_name)
        .ok_or_else(|| "Outlook account has no email".into())
}

async fn ensure_tangent_calendar(access_token: &str, existing: Option<&str>) -> Result<String, String> {
    if let Some(id) = existing.filter(|s| !s.trim().is_empty()) {
        return Ok(id.to_string());
    }
    #[derive(Deserialize)]
    struct Cal {
        id: Option<String>,
        name: Option<String>,
    }
    #[derive(Deserialize)]
    struct List {
        value: Option<Vec<Cal>>,
    }
    let client = reqwest::Client::new();
    let list: List = client
        .get(format!("{GRAPH}/me/calendars"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Could not list Outlook calendars: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid calendar list: {e}"))?;
    if let Some(found) = list.value.unwrap_or_default().into_iter().find(|c| {
        c.name
            .as_deref()
            .is_some_and(|n| n.eq_ignore_ascii_case(CHECKIN_CALENDAR_NAME))
    }) {
        if let Some(id) = found.id {
            return Ok(id);
        }
    }
    let created: Cal = client
        .post(format!("{GRAPH}/me/calendars"))
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "name": CHECKIN_CALENDAR_NAME }))
        .send()
        .await
        .map_err(|e| format!("Could not create Outlook calendar: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid create calendar response: {e}"))?;
    created
        .id
        .ok_or_else(|| "Outlook did not return a calendar id".into())
}

fn event_body(
    summary: &str,
    description: &str,
    start_local: &str,
    end_local: &str,
    timezone: &str,
    reminder_minutes: &[i32],
    recurring: bool,
) -> serde_json::Value {
    let reminder = reminder_minutes.first().copied().unwrap_or(15);
    let mut body = serde_json::json!({
        "subject": summary,
        "body": { "contentType": "text", "content": description },
        "start": { "dateTime": start_local, "timeZone": timezone },
        "end": { "dateTime": end_local, "timeZone": timezone },
        "isReminderOn": true,
        "reminderMinutesBeforeStart": reminder.max(0),
    });
    if recurring {
        body["recurrence"] = serde_json::json!({
            "pattern": { "type": "daily", "interval": 1 },
            "range": { "type": "noEnd" }
        });
    }
    body
}

async fn post_event(
    access_token: &str,
    calendar_id: &str,
    body: &serde_json::Value,
) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Created {
        id: Option<String>,
    }
    let client = reqwest::Client::new();
    let url = format!(
        "{GRAPH}/me/calendars/{}/events",
        urlencoding::encode(calendar_id)
    );
    let resp = client
        .post(url)
        .bearer_auth(access_token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Outlook create event failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(format!("Outlook Calendar error ({status}): {err}"));
    }
    let created: Created = resp
        .json()
        .await
        .map_err(|e| format!("Invalid Outlook event response: {e}"))?;
    created
        .id
        .ok_or_else(|| "Outlook did not return an event id".into())
}

async fn delete_event(access_token: &str, event_id: &str) -> Result<(), String> {
    if event_id.trim().is_empty() {
        return Ok(());
    }
    let client = reqwest::Client::new();
    let resp = client
        .delete(format!(
            "{GRAPH}/me/events/{}",
            urlencoding::encode(event_id)
        ))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Outlook delete failed: {e}"))?;
    if resp.status().as_u16() == 404 || resp.status().is_success() {
        return Ok(());
    }
    let err = resp.text().await.unwrap_or_default();
    Err(format!("Outlook delete failed: {err}"))
}

pub async fn oauth_connect(client_id: &str) -> Result<OutlookOAuthResult, String> {
    if client_id.trim().is_empty() {
        return Err("Outlook Client ID is required. Add VITE_MICROSOFT_OAUTH_CLIENT_ID and rebuild.".into());
    }
    let (verifier, challenge) = pkce_pair();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not start local server for sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://localhost:{port}/oauth/callback");
    let auth_url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&response_mode=query",
        urlencoding::encode(client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(SCOPE),
        urlencoding::encode(&challenge),
    );
    open::that(&auth_url).map_err(|e| format!("Could not open browser: {e}"))?;
    let code = wait_for_auth_code(listener).await?;
    let tokens = exchange_code(client_id, &code, &redirect_uri, &verifier).await?;
    if tokens.refresh_token.is_none() {
        return Err("Outlook did not issue a refresh token. Connect again.".into());
    }
    let email = user_email(&tokens.access_token).await?;
    Ok(OutlookOAuthResult { email, tokens })
}

pub async fn create_calendar_event(
    params: OutlookCreateEventParams,
) -> Result<OutlookCreateEventResult, String> {
    let tokens = ensure_fresh_tokens(&params.client_id, &params.tokens).await?;
    let calendar_id =
        ensure_tangent_calendar(&tokens.access_token, params.calendar_id.as_deref()).await?;
    let body = event_body(
        &params.summary,
        &params.description,
        &params.start_local,
        &params.end_local,
        &params.timezone,
        &params.reminder_minutes,
        false,
    );
    let event_id = post_event(&tokens.access_token, &calendar_id, &body).await?;
    Ok(OutlookCreateEventResult {
        event_id: Some(event_id),
        calendar_id: Some(calendar_id),
        tokens,
    })
}

pub async fn delete_calendar_event(
    params: OutlookDeleteEventParams,
) -> Result<OutlookDeleteEventResult, String> {
    let tokens = ensure_fresh_tokens(&params.client_id, &params.tokens).await?;
    delete_event(&tokens.access_token, &params.event_id).await?;
    Ok(OutlookDeleteEventResult { tokens })
}

#[tauri::command]
pub async fn outlook_oauth_connect(client_id: String) -> Result<OutlookOAuthResult, String> {
    oauth_connect(&client_id).await
}

#[tauri::command]
pub async fn outlook_calendar_create_event(
    params: OutlookCreateEventParams,
) -> Result<OutlookCreateEventResult, String> {
    create_calendar_event(params).await
}

#[tauri::command]
pub async fn outlook_calendar_delete_event(
    params: OutlookDeleteEventParams,
) -> Result<OutlookDeleteEventResult, String> {
    delete_calendar_event(params).await
}

#[tauri::command]
pub async fn outlook_calendar_sync_checkin(
    params: OutlookSyncCheckInParams,
) -> Result<OutlookSyncCheckInResult, String> {
    sync_checkin(params).await
}

pub async fn sync_checkin(
    params: OutlookSyncCheckInParams,
) -> Result<OutlookSyncCheckInResult, String> {
    let tokens = ensure_fresh_tokens(&params.client_id, &params.tokens).await?;
    if let Some(ids) = &params.existing_event_ids {
        for id in ids {
            let _ = delete_event(&tokens.access_token, id).await;
        }
    }
    if !params.enabled {
        return Ok(OutlookSyncCheckInResult {
            event_ids: vec![],
            calendar_id: params.calendar_id,
            tokens,
        });
    }
    let calendar_id =
        ensure_tangent_calendar(&tokens.access_token, params.calendar_id.as_deref()).await?;
    let slots = params.check_in_slots.unwrap_or_default();
    let mut event_ids = Vec::new();
    for slot in slots {
        let body = event_body(
            "Check Tangent",
            "Created by Tangent",
            &slot.start_local,
            &slot.end_local,
            &params.timezone,
            &[0],
            true,
        );
        event_ids.push(post_event(&tokens.access_token, &calendar_id, &body).await?);
    }
    Ok(OutlookSyncCheckInResult {
        event_ids,
        calendar_id: Some(calendar_id),
        tokens,
    })
}
