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
    let callback: (request: Request) => Promise<Response>;
    const result = await runWasmcloudLogin(
      ['--target', 'development'],
      captureIo().io,
      fakeDeps({
        cwd: greeter,
        env: { DI_FRAMEWORK_DEPLOY_TOKEN: '' },
        credentialsPath,
        listenLoopback: async (handler) => {
          const redirectUri = 'http://127.0.0.1:8765/callback';
          callback = handler;
          return { redirectUri, close: async () => undefined };
        },
        openUrl: async (url) => {
          authorizeUrls.push(url);
          const state = new URL(url).searchParams.get('state');
          expect(state).not.toBe('cli');
          expect(state!.length).toBeGreaterThanOrEqual(32);
          for (const query of [
            'code=injected',
            'code=injected&state=wrong',
            'error=access_denied&state=wrong',
          ]) {
            const response = await callback(new Request(`http://127.0.0.1:8765/callback?${query}`));
            expect(response.status).toBe(400);
            expect(existsSync(credentialsPath)).toBe(false);
          }
          expect(
            (await callback(new Request(`http://127.0.0.1:8765/callback?state=${state}`))).status,
          ).toBe(400);
          expect(
            (
              await callback(
                new Request(`http://127.0.0.1:8765/callback?code=pkce-code&state=${state}`),
              )
            ).status,
          ).toBe(200);
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

it.each([400, 200])(
  'closes the loopback listener when token exchange fails (HTTP %s)',
  async (status) => {
    const { greeter } = makeWorkspace();
    let callback: (request: Request) => Promise<Response>;
    let closed = false;
    const deps = fakeDeps({
      cwd: greeter,
      listenLoopback: async (handler) => {
        callback = handler;
        return {
          redirectUri: 'http://127.0.0.1:8765/callback',
          close: async () => {
            closed = true;
          },
        };
      },
      openUrl: async (url) => {
        const state = new URL(url).searchParams.get('state');
        await callback(new Request(`http://127.0.0.1:8765/callback?code=valid&state=${state}`));
      },
      fetch: async () => Response.json({}, { status }),
    });
    await expect(
      runWasmcloudLogin(['--target', 'development'], captureIo().io, deps),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_LOGIN_FAILED' });
    expect(closed).toBe(true);
  },
);

it('handles matching-state OAuth errors and closes the listener', async () => {
  const { greeter } = makeWorkspace();
  let callback: (request: Request) => Promise<Response>;
  let closed = false;
  const deps = fakeDeps({
    cwd: greeter,
    listenLoopback: async (handler) => {
      callback = handler;
      return {
        redirectUri: 'http://127.0.0.1:8765/callback',
        close: async () => {
          closed = true;
        },
      };
    },
    openUrl: async (url) => {
      const state = new URL(url).searchParams.get('state');
      expect(
        (
          await callback(
            new Request(`http://127.0.0.1:8765/callback?error=access_denied&state=${state}`),
          )
        ).status,
      ).toBe(400);
    },
  });
  await expect(
    runWasmcloudLogin(['--target', 'development'], captureIo().io, deps),
  ).rejects.toThrow('access_denied');
  expect(closed).toBe(true);
});

it('rejects positional arguments for login and logout', async () => {
  const deps = fakeDeps({ cwd: makeWorkspace().greeter });
  await expect(runWasmcloudLogin(['unexpected'], captureIo().io, deps)).rejects.toMatchObject({
    code: 'INVALID_USAGE',
  });
  await expect(runWasmcloudLogout(['unexpected'], captureIo().io, deps)).rejects.toMatchObject({
    code: 'INVALID_USAGE',
  });
});
