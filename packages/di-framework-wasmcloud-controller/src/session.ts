import {
  base64UrlDecodeString,
  base64UrlEncode,
  base64UrlEncodeString,
  readCookie,
  serializeCookie,
  timingSafeEqualString,
} from '@di-framework/auth';

export const SESSION_COOKIE = 'df_session';

export type SessionPayload = {
  sub: string;
  exp: number;
};

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(signature);
}

export async function encodeSession(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const body = base64UrlEncodeString(JSON.stringify(payload));
  const mac = await hmac(secret, body);
  return `${body}.${mac}`;
}

export async function decodeSession(
  token: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | undefined> {
  const split = token.lastIndexOf('.');
  if (split <= 0) return undefined;
  const body = token.slice(0, split);
  const mac = token.slice(split + 1);
  const expected = await hmac(secret, body);
  if (!(await timingSafeEqualString(mac, expected))) return undefined;
  try {
    const payload = JSON.parse(base64UrlDecodeString(body)) as SessionPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return undefined;
    if (payload.exp <= now) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure,
    maxAge: 600,
  });
}

export function readSessionCookie(request: Request): string | undefined {
  return readCookie(request, SESSION_COOKIE) ?? undefined;
}
