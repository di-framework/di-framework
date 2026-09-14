import { describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  deleteApplication,
  getApplication,
  getControllerHealth,
  putApplication,
  requireController,
  waitForApplication,
} from '../src/controller-client';
import {
  deleteCredential,
  readCredentialsFile,
  resolveAccessToken,
  storeCredential,
} from '../src/credentials';
import { DEFAULT_DEPS } from '../src/deps';
import type { DeployIntent } from '../src/intent';
import type { ClusterConnection } from '../src/target';
import { captureIo, fakeDeps, makeProject } from './helpers';

const connection: ClusterConnection = {
  target: 'development',
  namespace: 'platform',
  controller: { url: 'https://deploy.test/base/', host: 'deploy' },
  registry: { push: 'registry.test', pull: 'registry.test', insecure: false },
};
const intent: DeployIntent = {
  application: 'app',
  witName: 'app',
  image: `registry.test/app@sha256:${'a'.repeat(64)}`,
  deploymentDigest: 'digest',
  ingress: true,
  worker: false,
  bindings: [],
  hasActors: false,
  persistentStorage: false,
  cronJobs: [],
  queueHandlers: [],
};

describe('controller client', () => {
  it('requires a controller and reports health without credentials', async () => {
    expect(() => requireController({ ...connection, controller: undefined })).toThrow(
      /no deploy controller/,
    );
    const deps = fakeDeps({
      cwd: makeProject(),
      env: { DI_FRAMEWORK_DEPLOY_TOKEN: '' },
      fetch: async (input, init) => {
        expect(String(input)).toBe('https://deploy.test/base/health');
        expect(init?.headers).toEqual({ host: 'deploy', accept: 'application/json' });
        return new Response('ok');
      },
    });
    expect(await getControllerHealth(connection, deps)).toEqual({ ok: true, status: 200 });
    expect(await getControllerHealth({ ...connection, controller: undefined }, deps)).toEqual({
      ok: false,
      status: 0,
    });
    expect(
      await getControllerHealth(connection, {
        ...deps,
        fetch: async () => {
          throw new Error('offline');
        },
      }),
    ).toEqual({ ok: false, status: 0 });
  });

  it.each([
    [401, 'WASMCLOUD_LOGIN_REQUIRED'],
    [403, 'WASMCLOUD_DEPLOY_DENIED'],
    [409, 'WASMCLOUD_STORAGE_OWNERSHIP_CONFLICT'],
    [500, 'WASMCLOUD_CONTROLLER_REJECTED'],
  ] as const)('maps controller HTTP %s into an actionable error', async (status, code) => {
    const deps = fakeDeps({
      cwd: makeProject(),
      fetch: async () => Response.json({ error: 'denied', reason: 'policy' }, { status }),
    });
    await expect(putApplication(connection, intent, captureIo().io, deps)).rejects.toMatchObject({
      code,
    });
    await expect(deleteApplication(connection, 'app', captureIo().io, deps)).rejects.toMatchObject({
      code,
    });
  });

  it('treats missing applications as already deleted and tolerates non-JSON responses', async () => {
    const deps = fakeDeps({
      cwd: makeProject(),
      fetch: async (input, init) => {
        expect(String(input)).toEndWith('/applications/app%2Fname');
        expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' });
        return new Response('', { status: 404 });
      },
    });
    expect(await deleteApplication(connection, 'app/name', captureIo().io, deps)).toEqual({});
    expect(await getApplication(connection, 'app/name', deps)).toEqual({ status: 404, body: {} });
  });

  it('maps transport failures and reports readiness diagnostics after polling', async () => {
    const cwd = makeProject();
    const deps = fakeDeps({
      cwd,
      fetch: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(getApplication(connection, 'app', deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_CONTROLLER_UNREACHABLE',
      message: expect.stringContaining('connection refused'),
    });
    let polls = 0;
    let waits = 0;
    deps.fetch = async () => {
      polls++;
      return Response.json({
        ready: false,
        namespace: 'platform',
        diagnostics: 'image cannot be pulled',
      });
    };
    deps.wait = async (ms) => {
      expect(ms).toBe(2000);
      waits++;
    };
    const io = captureIo();
    await expect(waitForApplication(connection, 'app', deps, io.io)).rejects.toMatchObject({
      code: 'WASMCLOUD_DEPLOYMENT_NOT_READY',
      details: { name: 'app', namespace: 'platform', diagnostics: 'image cannot be pulled' },
    });
    expect(polls).toBe(31);
    expect(waits).toBe(30);
  });
});

describe('CLI credentials', () => {
  it('uses saved target credentials and tolerates invalid files', () => {
    const cwd = makeProject();
    const path = join(cwd, 'creds.json');
    fs.writeFileSync(path, '{"version":0,"targets":null}');
    expect(readCredentialsFile(path)).toEqual({ version: 1, targets: {} });
    const credential = { accessToken: 'saved', controller: connection.controller! };
    storeCredential(path, 'development', credential);
    storeCredential(path, 'other', credential);
    const deps = fakeDeps({ cwd, credentialsPath: path, env: { DI_FRAMEWORK_DEPLOY_TOKEN: '' } });
    expect(resolveAccessToken(deps, 'development')).toBe('saved');
    expect(deleteCredential(path, 'development')).toBe(true);
    expect(readCredentialsFile(path).targets.other).toEqual(credential);
    const remove = spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('cannot unlink');
    });
    try {
      expect(deleteCredential(path, 'other')).toBe(true);
    } finally {
      remove.mockRestore();
    }
    expect(readCredentialsFile(path).targets).toEqual({});
    expect(deleteCredential(path, 'absent')).toBe(false);
  });
});

it('opens the browser through the runner and receives callbacks on a real loopback listener', async () => {
  const runner = spyOn(DEFAULT_DEPS, 'runner').mockResolvedValue({ exitCode: 0 });
  try {
    await DEFAULT_DEPS.openUrl('https://deploy.test/oauth/authorize');
    expect(runner.mock.calls[0]?.[1]).toContain('https://deploy.test/oauth/authorize');
    expect(DEFAULT_DEPS.credentialsPath()).toEndWith('/.di-framework/credentials.json');
  } finally {
    runner.mockRestore();
  }
  const loopback = await DEFAULT_DEPS.listenLoopback(
    async (request) => new Response(new URL(request.url).searchParams.get('code')),
  );
  try {
    expect(new URL(loopback.redirectUri).hostname).toBe('127.0.0.1');
    expect(await (await fetch(`${loopback.redirectUri}?code=test`)).text()).toBe('test');
  } finally {
    await loopback.close();
  }
});
