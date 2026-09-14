import { CommandFailure, type CliIo } from '@di-framework/cli-extension';
import { resolveAccessToken } from './credentials';
import type { WasmcloudDeps } from './deps';
import type { DeployIntent } from './intent';
import type { ClusterConnection } from './target';

const WAIT_ATTEMPTS = 30;
const WAIT_INTERVAL_MS = 2_000;

export { CONTROLLER_HOST } from './target';

export type ApplicationStatus = {
  application?: string;
  name?: string;
  namespace?: string;
  ready?: boolean;
  org?: string;
  team?: string;
  owner?: string;
  deleted?: boolean;
  error?: string;
  reason?: string;
  diagnostics?: string;
};

export function requireController(connection: ClusterConnection): {
  url: string;
  host: string;
} {
  if (connection.controller === undefined) {
    throw new CommandFailure(
      'WASMCLOUD_CONTROLLER_UNAVAILABLE',
      `Target "${connection.target}" has no deploy controller. Managed platforms export endpoints.http; external targets set controller.`,
      2,
      { target: connection.target },
    );
  }
  return connection.controller;
}

function applicationUrl(connection: ClusterConnection, name: string): string {
  const controller = requireController(connection);
  return new URL(`applications/${encodeURIComponent(name)}`, ensureSlash(controller.url)).toString();
}

function healthUrl(connection: ClusterConnection): string {
  const controller = requireController(connection);
  return new URL('health', ensureSlash(controller.url)).toString();
}

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function headers(connection: ClusterConnection, token: string, json = false): Record<string, string> {
  const controller = requireController(connection);
  const result: Record<string, string> = {
    host: controller.host,
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (json) result['content-type'] = 'application/json';
  return result;
}

async function controllerFetch(
  deps: WasmcloudDeps,
  connection: ClusterConnection,
  init: { method: string; url: string; token: string; body?: string },
): Promise<Response> {
  try {
    return await deps.fetch(init.url, {
      method: init.method,
      headers: headers(connection, init.token, init.body !== undefined),
      body: init.body,
    });
  } catch (error) {
    throw new CommandFailure(
      'WASMCLOUD_CONTROLLER_UNREACHABLE',
      `Could not reach the deploy controller at ${requireController(connection).url}: ${error instanceof Error ? error.message : String(error)}`,
      3,
      { target: connection.target, url: requireController(connection).url },
    );
  }
}

async function readJson(response: Response): Promise<ApplicationStatus> {
  try {
    return (await response.json()) as ApplicationStatus;
  } catch {
    return {};
  }
}

function mapStatus(response: Response, body: ApplicationStatus, action: string): never {
  if (response.status === 401) {
    throw new CommandFailure(
      'WASMCLOUD_LOGIN_REQUIRED',
      'The deploy controller rejected the access token. Run: di-framework wasmcloud login',
      2,
      { status: response.status },
    );
  }
  if (response.status === 403) {
    throw new CommandFailure(
      'WASMCLOUD_DEPLOY_DENIED',
      `Not allowed to ${action} this application (${body.reason ?? body.error ?? 'forbidden'})`,
      2,
      { status: response.status, error: body.error },
    );
  }
  if (response.status === 409) {
    throw new CommandFailure(
      'WASMCLOUD_STORAGE_OWNERSHIP_CONFLICT',
      body.error ?? 'Storage path is already claimed',
      2,
      { status: response.status, ...body },
    );
  }
  throw new CommandFailure(
    'WASMCLOUD_CONTROLLER_REJECTED',
    `Deploy controller ${action} failed (${response.status}): ${body.error ?? response.statusText}`,
    3,
    { status: response.status, error: body.error },
  );
}

export async function putApplication(
  connection: ClusterConnection,
  intent: DeployIntent,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<ApplicationStatus> {
  const token = resolveAccessToken(deps, connection.target);
  io.stdout.write(
    `Deploying ${intent.application} through the controller at ${requireController(connection).url}...\n`,
  );
  const response = await controllerFetch(deps, connection, {
    method: 'POST',
    url: applicationUrl(connection, intent.witName),
    token,
    body: JSON.stringify(intent),
  });
  const body = await readJson(response);
  if (response.status >= 300) mapStatus(response, body, 'deploy');
  return body;
}

export async function deleteApplication(
  connection: ClusterConnection,
  name: string,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<ApplicationStatus> {
  const token = resolveAccessToken(deps, connection.target);
  io.stdout.write(`Removing ${name} through the controller at ${requireController(connection).url}...\n`);
  const response = await controllerFetch(deps, connection, {
    method: 'DELETE',
    url: applicationUrl(connection, name),
    token,
  });
  const body = await readJson(response);
  if (response.status >= 300 && response.status !== 404) mapStatus(response, body, 'destroy');
  return body;
}

export async function getApplication(
  connection: ClusterConnection,
  name: string,
  deps: WasmcloudDeps,
): Promise<{ status: number; body: ApplicationStatus }> {
  const token = resolveAccessToken(deps, connection.target);
  const response = await controllerFetch(deps, connection, {
    method: 'GET',
    url: applicationUrl(connection, name),
    token,
  });
  return { status: response.status, body: await readJson(response) };
}

export async function getControllerHealth(
  connection: ClusterConnection,
  deps: WasmcloudDeps,
): Promise<{ ok: boolean; status: number }> {
  try {
    const controller = requireController(connection);
    const response = await deps.fetch(healthUrl(connection), {
      method: 'GET',
      headers: { host: controller.host, accept: 'application/json' },
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function waitForApplication(
  connection: ClusterConnection,
  name: string,
  deps: WasmcloudDeps,
  io?: CliIo,
): Promise<void> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
    const result = await getApplication(connection, name, deps);
    if (result.status === 200 && result.body.ready === true) return;
    await deps.wait(WAIT_INTERVAL_MS);
  }
  const last = await getApplication(connection, name, deps);
  if (io !== undefined) {
    io.stderr.write(
      `WorkloadDeployment ${name} did not become ready.${last.body.diagnostics ? `\n${last.body.diagnostics}` : ''}\n`,
    );
  }
  throw new CommandFailure(
    'WASMCLOUD_DEPLOYMENT_NOT_READY',
    `WorkloadDeployment ${name} did not become ready`,
    3,
    { name, namespace: last.body.namespace, diagnostics: last.body.diagnostics },
  );
}
