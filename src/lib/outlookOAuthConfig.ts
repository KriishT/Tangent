/** Publisher Microsoft identity (Azure) client — baked in at build time. */

export const MICROSOFT_OAUTH_CLIENT_ID =
  (import.meta.env.VITE_MICROSOFT_OAUTH_CLIENT_ID as string | undefined)?.trim() ?? "";

export function isOutlookOAuthConfigured(): boolean {
  return MICROSOFT_OAUTH_CLIENT_ID.length > 0;
}
