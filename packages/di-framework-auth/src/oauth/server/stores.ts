import type {
  AuthCodeStore,
  ClientStore,
  ConsentStore,
  OAuthAuthorizationCode,
  OAuthClientConfig,
  OAuthConsent,
  OAuthRefreshTokenRecord,
  OAuthTokenStore,
} from './types.ts';

export class InMemoryClientStore implements ClientStore {
  private clients = new Map<string, OAuthClientConfig>();

  constructor(clients: OAuthClientConfig[] = []) {
    for (const client of clients) {
      this.clients.set(client.clientId, client);
    }
  }

  registerClient(client: OAuthClientConfig): void {
    this.clients.set(client.clientId, client);
  }

  async getClient(clientId: string): Promise<OAuthClientConfig | null> {
    return this.clients.get(clientId) ?? null;
  }
}

export class InMemoryAuthCodeStore implements AuthCodeStore {
  private codes = new Map<string, OAuthAuthorizationCode>();

  async createCode(code: OAuthAuthorizationCode): Promise<void> {
    this.codes.set(code.code, { ...code, consumed: false });
  }

  async consumeCode(codeString: string): Promise<OAuthAuthorizationCode | null> {
    const entry = this.codes.get(codeString);
    if (!entry) return null;
    if (entry.consumed) return null; // Prevent replay!
    entry.consumed = true;
    this.codes.set(codeString, entry);
    return entry;
  }
}

export class InMemoryConsentStore implements ConsentStore {
  private consents = new Map<string, OAuthConsent>();

  private key(clientId: string, subjectId: string): string {
    return `${clientId}:${subjectId}`;
  }

  async getConsent(clientId: string, subjectId: string): Promise<OAuthConsent | null> {
    return this.consents.get(this.key(clientId, subjectId)) ?? null;
  }

  async saveConsent(consent: OAuthConsent): Promise<void> {
    this.consents.set(this.key(consent.clientId, consent.subjectId), consent);
  }
}

export class InMemoryOAuthTokenStore implements OAuthTokenStore {
  private refreshTokens = new Map<string, OAuthRefreshTokenRecord>();

  async saveRefreshToken(token: OAuthRefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(token.token, token);
  }

  async revokeToken(tokenString: string): Promise<boolean> {
    const token = this.refreshTokens.get(tokenString);
    if (!token) return false;
    token.revoked = true;
    return true;
  }

  async isRevoked(tokenString: string): Promise<boolean> {
    const token = this.refreshTokens.get(tokenString);
    if (!token) return true;
    return token.revoked;
  }
}
