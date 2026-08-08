import { SESSION_COOKIE_NAME } from '../cookies.ts';
import type { AuthStrategy } from '../types.ts';

/**
 * OpenAPI security metadata.
 *
 * `@di-framework/http` gained `securitySchemes` and per-operation `security`
 * fields, but it knows nothing about authentication — the values are supplied
 * from here, so the http package never learns auth vocabulary.
 */

export interface SecuritySchemeOptions {
  sessionCookieName?: string;
  apiKeyHeaderName?: string;
  bearerFormat?: string;
  /** OIDC discovery URL, for an `openIdConnect` scheme. */
  openIdConnectUrl?: string;
}

/** Derive `components.securitySchemes` from the strategies in use. */
export function securitySchemesFor(
  strategies: readonly AuthStrategy[],
  options: SecuritySchemeOptions = {},
): Record<string, unknown> {
  const schemes: Record<string, unknown> = {};
  // A chained strategy reports its members joined with '+'.
  const names = new Set(strategies.flatMap((strategy) => strategy.name.split('+')));

  if (names.has('session')) {
    schemes.sessionAuth = {
      type: 'apiKey',
      in: 'cookie',
      name: options.sessionCookieName ?? SESSION_COOKIE_NAME,
    };
  }
  if (names.has('bearer')) {
    schemes.bearerAuth = {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: options.bearerFormat ?? 'JWT',
    };
  }
  if (names.has('api-key')) {
    schemes.apiKeyAuth = {
      type: 'apiKey',
      in: 'header',
      name: options.apiKeyHeaderName ?? 'X-API-Key',
    };
  }
  if (options.openIdConnectUrl) {
    schemes.openIdConnect = {
      type: 'openIdConnect',
      openIdConnectUrl: options.openIdConnectUrl,
    };
  }
  return schemes;
}

/** `@Endpoint({ security: secured('bearerAuth') })`. */
export function secured(...names: string[]): Array<Record<string, string[]>> {
  return names.map((name) => ({ [name]: [] }));
}

/**
 * `security: []` — explicitly public, overriding the document-level default.
 *
 * The empty array is meaningful in OpenAPI, which is why the generator tests for
 * `undefined` rather than truthiness.
 */
export const publicEndpoint: Array<Record<string, string[]>> = [];
