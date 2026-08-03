import { SESSION_COOKIE_NAME } from '../cookies.ts';
import type { CsrfGuard } from '../csrf.ts';
import { authenticated, authFailed, noCredential } from '../result.ts';
import type { SessionManager } from '../session/manager.ts';
import type { AuthStrategy } from '../types.ts';

export interface SessionCookieStrategyOptions {
  sessions: SessionManager;
  cookieName?: string;
  /**
   * CSRF guard applied to state-changing requests.
   *
   * Only cookie-authenticated requests need this: a bearer token or API key is
   * not sent automatically by the browser, so those requests cannot be forged
   * cross-site and must not be forced to carry a token.
   */
  csrf?: CsrfGuard;
}

/** Server-side sessions carried in a `__Host-` cookie. */
export function sessionCookieStrategy(options: SessionCookieStrategyOptions): AuthStrategy {
  const cookieName = options.cookieName ?? SESSION_COOKIE_NAME;

  return {
    name: 'session',

    async authenticate(context) {
      const token = context.cookies[cookieName];
      if (!token) return noCredential();

      const lookup = await options.sessions.resolve(token);
      if (lookup.state === 'not-found') {
        return authFailed('session_not_found', `No session for cookie '${cookieName}'`);
      }
      if (lookup.state === 'expired') {
        return authFailed('session_expired', `Session ended (${lookup.reason} timeout)`);
      }

      // CSRF runs after the session resolves, because the token is bound to the
      // session id. A 403, not a 401 — the credential was fine, the request
      // shape was not, and re-authenticating would not help.
      if (options.csrf) {
        const verdict = await options.csrf.verify(context.request, lookup.record.id);
        if (!verdict.ok) {
          return authFailed('csrf_failed', `CSRF check failed (${verdict.reason})`, {
            status: 403,
          });
        }
      }

      return authenticated(lookup.principal);
    },

    // No `challenge`: a browser prompted with `WWW-Authenticate` for a
    // cookie-session app shows a native dialog the app cannot style or handle.
  };
}
