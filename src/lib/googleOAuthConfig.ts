/** Publisher OAuth credentials — baked in at build time via Vite env vars. */

export const GOOGLE_OAUTH_CLIENT_ID =
  (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined)?.trim() ?? "";

/** Only needed for Web-application OAuth clients; Desktop clients use PKCE without a secret. */
export const GOOGLE_OAUTH_CLIENT_SECRET =
  (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_SECRET as string | undefined)?.trim() ?? "";

export function isGoogleOAuthConfigured(): boolean {
  return GOOGLE_OAUTH_CLIENT_ID.length > 0;
}
