import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeCredential } from '../src/credentials';
import { runWasmcloudLogin } from '../src/login';
import { runWasmcloudLogout } from '../src/logout';
import { captureIo, fakeDeps, makeWorkspace } from './helpers';

describe('wasmcloud login', () => {
  it('stores a PKCE access token for the target', async () => {
    const { greeter } = makeWorkspace();
    const credentialsPath = join(greeter, 'creds.json');
    const authorizeUrls: string[] = [];
    const result = await runWasmcloudLogin(
      ['--target', 'development'],
      captureIo().io,
      fakeDeps({
        cwd: greeter,
        env: { DI_FRAMEWORK_DEPLOY_TOKEN: '' },
        credentialsPath,
        listenLoopback: async (handler) => {
          const redirectUri = 'http://127.0.0.1:8765/callback';
          queueMicrotask(() => {
            void handler(new Request(`${redirectUri}?code=pkce-code&state=cli`));
          });
          return { redirectUri, close: async () => undefined };
        },
        openUrl: async (url) => {
          authorizeUrls.push(url);
        },
        fetch: async (input) => {
          const url = String(input);
          if (url.includes('/oauth/token')) {
            return new Response(
              JSON.stringify({
                access_token: 'access-from-pkce',
                refresh_token: 'refresh',
                expires_in: 60,
              }),
              { status: 200 },
            );
          }
          return new Response('unexpected', { status: 500 });
        },
      }),
    );

    expect(authorizeUrls[0]).toContain('/oauth/authorize');
    expect(authorizeUrls[0]).toContain('code_challenge=');
    expect(authorizeUrls[0]).toContain('code_challenge_method=S256');
    expect(result.data).toMatchObject({ target: 'development' });
    const stored = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
      targets: { development: { accessToken: string } };
    };
    expect(stored.targets.development.accessToken).toBe('access-from-pkce');
  });

  it('logout removes the stored credential', async () => {
    const { greeter } = makeWorkspace();
    const credentialsPath = join(greeter, 'creds.json');
    storeCredential(credentialsPath, 'development', {
      accessToken: 'x',
      controller: { url: 'https://deploy.example.test', host: 'deploy' },
    });
    const result = await runWasmcloudLogout(
      ['--target', 'development'],
      captureIo().io,
      fakeDeps({
        cwd: greeter,
        env: { DI_FRAMEWORK_DEPLOY_TOKEN: '' },
        credentialsPath,
      }),
    );
    expect(result.data).toMatchObject({ target: 'development', removed: true });
    expect(existsSync(credentialsPath)).toBe(false);
  });
});
