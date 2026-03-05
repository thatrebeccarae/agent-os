import { randomBytes } from 'node:crypto';
import { auth } from '@googleapis/gmail';

export type AccountId = 'primary' | 'secondary';

const ACCOUNTS: readonly AccountId[] = ['primary', 'secondary'] as const;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar', // Phase 9: Google Calendar read/write
];

const REDIRECT_URI = 'http://localhost:3210/oauth/gmail/callback';

/** Cached OAuth2 clients per account. */
const _clients = new Map<AccountId, InstanceType<typeof auth.OAuth2>>();

/** CSRF state token for OAuth flow. */
let _oauthState: string | null = null;

/** Resolve the refresh token env var for a given account. */
function getRefreshToken(account: AccountId): string | undefined {
  if (account === 'primary') {
    return process.env.GMAIL_REFRESH_TOKEN_PRIMARY || process.env.GMAIL_REFRESH_TOKEN;
  }
  return process.env.GMAIL_REFRESH_TOKEN_SECONDARY;
}

/** Returns true when client credentials + refresh token are set for an account. */
export function isGmailConfigured(account: AccountId = 'primary'): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    getRefreshToken(account)
  );
}

/** Returns all accounts that have refresh tokens configured. */
export function getConfiguredAccounts(): AccountId[] {
  return ACCOUNTS.filter((a) => isGmailConfigured(a));
}

/** Returns true when client ID + secret are set (enough for OAuth flow). */
export function isOAuthConfigurable(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** Creates or returns a cached OAuth2 client for the given account. */
export function getOAuth2Client(account: AccountId = 'primary'): InstanceType<typeof auth.OAuth2> {
  const cached = _clients.get(account);
  if (cached) return cached;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = getRefreshToken(account);

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }

  const client = new auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  if (refreshToken) {
    client.setCredentials({ refresh_token: refreshToken });
  }

  _clients.set(account, client);
  return client;
}

/** Generates the Google consent URL for the OAuth flow with CSRF state. */
export function getConsentUrl(): string {
  // Always use a fresh client for consent (not cached per-account)
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }
  const client = new auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  _oauthState = randomBytes(32).toString('hex');
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state: _oauthState,
  });
}

/** Validates the CSRF state parameter from the OAuth callback. */
export function validateOAuthState(state: string): boolean {
  if (!_oauthState) return false;
  const valid = state === _oauthState;
  _oauthState = null; // single use
  return valid;
}

/** Exchanges an authorization code for tokens. Returns the refresh token. */
export async function exchangeCode(code: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }
  const client = new auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh token received. Revoke access at https://myaccount.google.com/permissions and try again.',
    );
  }

  return tokens.refresh_token;
}
