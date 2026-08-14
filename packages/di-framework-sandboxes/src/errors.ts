export type ApiErrorBody = {
  code: string;
  message: string;
};

export class SandboxApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | undefined;

  constructor(status: number, body?: ApiErrorBody) {
    super(body?.message ?? `sandbox API request failed with status ${status}`);
    this.name = 'SandboxApiError';
    this.status = status;
    this.body = body;
  }
}

export class SandboxTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxTimeoutError';
  }
}

export class SandboxCommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, result: { exitCode: number; stdout: string; stderr: string }) {
    super(message);
    this.name = 'SandboxCommandError';
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}
