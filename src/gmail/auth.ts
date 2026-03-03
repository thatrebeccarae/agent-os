import { randomBytes } from 'node:crypto';
import { auth } from '@googleapis/gmail';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar', // Phase 9: Google Calendar read/write
];

const REDIRECT_URI = 'http://localhost:3210/oauth/gmail/callback';

let _oauth2Client: InstanceType<typeof auth.OAuth2> | null = null;

/** CSRF state token for OAuth flow. */
let _oauthState: string | null = null;

/** Returns true only when all 3 required env vars are set. */
export function isGmailConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
  );
}

/** Returns true when client ID + secret are set (enough for OAuth flow). */
export function isOAuthConfigurable(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** Creates or returns a cached OAuth2 client with refresh token set. */
export function getOAuth2Client(): InstanceType<typeof auth.OAuth2> {
  if (_oauth2Client) return _oauth2Client;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }

  _oauth2Client = new auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  if (refreshToken) {
    _oauth2Client.setCredentials({ refresh_token: refreshToken });
  }

  return _oauth2Client;
}

/** Generates the Google consent URL for the OAuth flow with CSRF state. */
export function getConsentUrl(): string {
  const client = getOAuth2Client();
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
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh token received. Revoke access at https://myaccount.google.com/permissions and try again.',
    );
  }

  return tokens.refresh_token;
}
