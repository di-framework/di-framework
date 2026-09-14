import { Kube } from './bindings';

export type KubeRequest = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

export type KubeResponse = {
  status: number;
  body: string;
};

export type ClusterSettings = {
  namespace: string;
  kubeApi: string;
  kubeToken: string;
};

export class KubeError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'KubeError';
    this.status = status;
  }
}

export async function kubeCall(
  kube: Kube,
  settings: ClusterSettings,
  request: { method: string; path: string; body?: unknown },
): Promise<KubeResponse> {
  const url = `${settings.kubeApi.replace(/\/$/, '')}${request.path}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${settings.kubeToken}`,
    accept: 'application/json',
  };
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  const raw = (await kube.send({
    method: request.method,
    url,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  } satisfies KubeRequest)) as KubeResponse;
  return raw;
}

export async function kubeJson<T>(
  kube: Kube,
  settings: ClusterSettings,
  request: { method: string; path: string; body?: unknown },
): Promise<{ status: number; value: T | undefined; body: string }> {
  const response = await kubeCall(kube, settings, request);
  if (response.body.trim() === '') return { status: response.status, value: undefined, body: '' };
  try {
    return { status: response.status, value: JSON.parse(response.body) as T, body: response.body };
  } catch {
    return { status: response.status, value: undefined, body: response.body };
  }
}

export function namespacedPath(api: string, namespace: string, resource: string, name?: string): string {
  const base = `${api}/namespaces/${encodeURIComponent(namespace)}/${resource}`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

export const WD_API = '/apis/runtime.wasmcloud.dev/v1alpha1';
export const CORE_API = '/api/v1';
export const BATCH_API = '/apis/batch/v1';
