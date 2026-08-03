/**
 * Cookie serialisation with secure-by-default attributes.
 *
 * The defaults implement the `__Host-` prefix (RFC 6265bis §4.1.3): `Secure`,
 * `Path=/`, and no `Domain`. That combination is what makes a cookie
 * un-injectable from a sibling subdomain — without it, an XSS on
 * `blog.example.com` can set a session cookie that `app.example.com` will
 * happily accept, which is session fixation with extra steps.
 */

export interface CookieAttributes {
  path?: string;
  /**
   * Setting this makes the `__Host-` prefix illegal, so {@link serializeCookie}
   * downgrades the name to `__Secure-` and warns. Needed for cross-subdomain
   * SSO; see the README, which covers the CSRF consequence in the same breath.
   */
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitioned?: boolean;
}

export const DEFAULT_COOKIE_ATTRIBUTES: Required<
  Pick<CookieAttributes, 'path' | 'httpOnly' | 'secure' | 'sameSite'>
> = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
};

export const SESSION_COOKIE_NAME = '__Host-sid';
export const CSRF_COOKIE_NAME = '__Host-csrf';
export const OAUTH_STATE_COOKIE_NAME = '__Host-oauth-state';
export const WEBAUTHN_COOKIE_NAME = '__Host-webauthn';

/** RFC 6265 cookie-name token: no control characters, no separators. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: RFC 6265 forbids CTLs in cookie names.
const INVALID_NAME = /[\x00-\x1f\x7f ()<>@,;:\\"/[\]?={}\t]/;
/** RFC 6265 cookie-value: no control characters, whitespace, quotes, comma, semicolon, backslash. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: RFC 6265 forbids CTLs in cookie values.
const INVALID_VALUE = /[\x00-\x1f\x7f ",;\\]/;

let downgradeWarned = false;

/**
 * Enforce the invariants implied by a cookie's name prefix.
 *
 * A `__Host-` cookie that quietly loses its `Secure` flag or gains a `Domain` is
 * not a style problem — it is a cookie that no longer has the property its name
 * advertises, in a codebase where a reviewer will read the name and assume it
 * does. So this throws rather than fixing it up.
 */
export function assertCookiePolicy(name: string, attributes: CookieAttributes): void {
  if (name.startsWith('__Host-')) {
    if (attributes.secure === false) throw new Error(`Cookie '${name}' requires Secure`);
    if (attributes.domain !== undefined) throw new Error(`Cookie '${name}' must not set Domain`);
    if (attributes.path !== undefined && attributes.path !== '/') {
      throw new Error(`Cookie '${name}' requires Path=/`);
    }
  } else if (name.startsWith('__Secure-') && attributes.secure === false) {
    throw new Error(`Cookie '${name}' requires Secure`);
  }
}

/**
 * Drop `__Host-` to `__Secure-` when a `Domain` is requested, warning once.
 *
 * Silently emitting a `__Host-`-prefixed cookie with a `Domain` attribute is
 * worse than either alternative: browsers reject it outright, so the session
 * simply never persists and the failure looks like a bug somewhere else.
 */
export function adjustCookieName(name: string, attributes: CookieAttributes): string {
  if (!name.startsWith('__Host-') || attributes.domain === undefined) return name;
  const downgraded = `__Secure-${name.slice('__Host-'.length)}`;
  if (!downgradeWarned) {
    downgradeWarned = true;
    console.warn(
      `[@di-framework/auth] Cookie '${name}' was renamed to '${downgraded}' because a Domain ` +
        'attribute was set. __Host- cookies cannot carry a Domain. A __Secure- cookie is ' +
        'writable by every subdomain, so pair this with strict CSRF checking.',
    );
  }
  return downgraded;
}

export function serializeCookie(
  name: string,
  value: string,
  attributes: CookieAttributes = {},
): string {
  const merged: CookieAttributes = { ...DEFAULT_COOKIE_ATTRIBUTES, ...attributes };
  const finalName = adjustCookieName(name, merged);

  if (INVALID_NAME.test(finalName))
    throw new Error(`Invalid cookie name: ${JSON.stringify(finalName)}`);
  if (INVALID_VALUE.test(value)) throw new Error(`Invalid cookie value for '${finalName}'`);
  assertCookiePolicy(finalName, merged);

  // SameSite=None is meaningless without Secure and is rejected by browsers.
  if (merged.sameSite === 'None' && !merged.secure) {
    throw new Error(`Cookie '${finalName}' uses SameSite=None, which requires Secure`);
  }

  const parts = [`${finalName}=${value}`];
  if (merged.path) parts.push(`Path=${merged.path}`);
  if (merged.domain) parts.push(`Domain=${merged.domain}`);
  if (merged.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(merged.maxAge)}`);
  if (merged.expires) parts.push(`Expires=${merged.expires.toUTCString()}`);
  if (merged.sameSite) parts.push(`SameSite=${merged.sameSite}`);
  if (merged.secure) parts.push('Secure');
  if (merged.httpOnly) parts.push('HttpOnly');
  if (merged.partitioned) parts.push('Partitioned');
  return parts.join('; ');
}

/** A `Set-Cookie` value that deletes the named cookie. */
export function clearCookie(name: string, attributes: CookieAttributes = {}): string {
  return serializeCookie(name, '', { ...attributes, maxAge: 0, expires: new Date(0) });
}

/** Parse a `Cookie` request header. Later duplicates do not override earlier ones. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    out[name] = pair.slice(separator + 1).trim();
  }
  return out;
}

/** Read one cookie from a request. */
export function readCookie(request: Request, name: string): string | undefined {
  return parseCookies(request.headers.get('cookie'))[name];
}
