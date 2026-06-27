# Google Calendar OAuth

Tangent can create Google Calendar events directly when a user connects their Google account. Without connecting, the Calendar button still opens a prefilled event in the browser (no sign-in).

## For users

1. Open **Settings → Google Calendar**.
2. Click **Connect Google Calendar**.
3. Sign in with Google and approve access.
4. On thoughts with a due time, use **Calendar** (`[g]` in Triage) — events are created automatically.

Disconnect anytime in Settings.

## For publishers (you, once)

### 1. Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or pick an existing one).
3. **APIs & Services → Library** → enable **Google Calendar API**.

### 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. Choose **External** (or Internal for Google Workspace).
3. App name: `Tangent`, support email, developer contact.
4. Scopes — add both:
   - `https://www.googleapis.com/auth/calendar` (full access — needed for the separate **Tangent Reminders** calendar)
   - `https://www.googleapis.com/auth/calendar.events` is included in full `calendar` scope; you only need `calendar`.
5. While in **Testing**, add beta tester Gmail addresses under **Test users**.

For public release, submit for **verification** and add a privacy policy URL.

### 3. OAuth client

1. **Credentials → Create credentials → OAuth client ID**.
2. Application type: **Desktop app** (recommended — no client secret needed).
3. Copy the **Client ID**.

### 4. Bake credentials into the build

```powershell
cd tangent
copy .env.example .env
# Edit .env — set VITE_GOOGLE_OAUTH_CLIENT_ID=your-id.apps.googleusercontent.com
npm run tauri:build
```

For CI/releases, set `VITE_GOOGLE_OAUTH_CLIENT_ID` as a secret env var before the build step.

End users never see or edit these values.

### 5. Beta vs production

| Stage | What to do |
|-------|------------|
| Beta | Consent screen in Testing; add each tester’s Gmail |
| Public | OAuth verification + privacy policy |

## Privacy

- OAuth tokens are stored locally in SQLite (same as other settings).
- Scope is limited to Google Calendar (create events and a separate reminders calendar).
- Client ID is public in the app binary (normal for OAuth); do not ship a client secret unless required.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| “Not configured in this build” | Publisher must set `VITE_GOOGLE_OAUTH_CLIENT_ID` in `.env` and rebuild. |
| “Sign-in timed out” | Finish browser flow within 5 minutes. |
| `access_denied` | Add the user as a test user (Testing mode) or complete verification. |
| `redirect_uri_mismatch` | Use a **Desktop** OAuth client. |
| API errors after connect | Ensure Calendar API is enabled on the project. |
| `insufficient authentication scopes` on phone reminders | OAuth consent screen is missing `.../auth/calendar`. Add it under **Scopes**, save, **Disconnect** then **Connect** in Settings. |
