/**
 * Shared error handling for Google API clients (Gmail, Calendar).
 */

export function handleGoogleApiError(error: unknown, context: string): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = Number((error as { code: unknown }).code);
    if (code === 401) return `Error: ${context} authorization expired. Re-authorize via /oauth/gmail/start`;
    if (code === 403) return `Error: ${context} API not enabled or insufficient permissions. Check GCP console.`;
    if (code === 429) return `Error: ${context} API rate limit exceeded. Wait a moment and try again.`;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return `Error: ${msg}`;
}
