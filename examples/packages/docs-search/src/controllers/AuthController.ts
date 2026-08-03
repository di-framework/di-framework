import { useContainer } from '@di-framework/core/container';
import { Component } from '@di-framework/core/decorators';
import {
  Controller,
  Endpoint,
  type Json,
  json,
  type RequestSpec,
  type ResponseSpec,
} from '@di-framework/http';
import { router } from '../router';
import { AuthService, type TokenResponse } from '../services/AuthService';

type ErrorBody = { error: string };

@Controller()
export class AuthController {
  constructor(@Component(AuthService) private readonly auth: AuthService) {}

  async exchangeToken(authorizationHeader: string | null) {
    return this.auth.exchangeOidc(authorizationHeader);
  }

  @Endpoint({
    summary: 'Mint reindex token',
    description:
      'Exchange a GitHub Actions OIDC JWT for a short-lived reindex Bearer token signed by the Worker.',
    responses: {
      '200': { description: 'Reindex access token' },
      '401': { description: 'Missing or invalid OIDC token' },
      '403': { description: 'OIDC claims not allowed' },
    },
  })
  static post = router.post<
    RequestSpec<Json<Record<string, never>>>,
    ResponseSpec<TokenResponse | ErrorBody>
  >('/auth/token', async (req) => {
    const controller = useContainer().resolve(AuthController);
    const result = await controller.exchangeToken(req.headers.get('authorization'));
    if (!result.ok) {
      return json({ error: result.error }, { status: result.status });
    }
    return json(result.body);
  });
}
