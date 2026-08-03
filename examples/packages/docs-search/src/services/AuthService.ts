import { Component, Container } from '@di-framework/core/decorators';
import { type AuthResult, authorizeReindex, issueReindexToken, verifyGitHubOidc } from '../auth';
import type { Env } from '../env';

export type TokenResponse = {
  token_type: 'Bearer';
  access_token: string;
  expires_in: number;
  expires_at: string;
  scope: 'reindex';
};

/**
 * Auth facade for HTTP controllers — GitHub OIDC exchange and reindex authorization.
 * Low-level JWT helpers stay in `auth.ts` for unit testing without DI.
 */
@Container()
export class AuthService {
  constructor(@Component('Env') private readonly getEnv: () => Env) {}

  private env(): Env {
    return this.getEnv();
  }

  /** Exchange a Bearer GitHub Actions OIDC JWT for a short-lived reindex token. */
  async exchangeOidc(
    authorizationHeader: string | null,
  ): Promise<{ ok: true; body: TokenResponse } | { ok: false; status: number; error: string }> {
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? '');
    if (!match?.[1]) {
      return { ok: false, status: 401, error: 'Bearer GitHub OIDC token required' };
    }

    const oidc = await verifyGitHubOidc(match[1].trim(), this.env());
    if (!oidc.ok) {
      return { ok: false, status: oidc.status, error: oidc.error };
    }

    try {
      const issued = await issueReindexToken(this.env(), {
        sub: oidc.subject,
        via: 'github-oidc',
      });
      return {
        ok: true,
        body: {
          token_type: 'Bearer',
          access_token: issued.token,
          expires_in: issued.expiresIn,
          expires_at: issued.expiresAt,
          scope: 'reindex',
        },
      };
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: err instanceof Error ? err.message : 'Failed to mint token',
      };
    }
  }

  /** Accept GitHub OIDC or a worker-minted reindex JWT. */
  authorizeReindex(request: Request): Promise<AuthResult> {
    return authorizeReindex(request, this.env());
  }
}
