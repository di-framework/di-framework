export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export class CronJobNotFoundError extends CronError {
  public readonly jobId: string;
  public readonly availableJobs: string[];

  constructor(jobId: string, availableJobs: string[] = []) {
    super(
      `Scheduled job "${jobId}" not found.${
        availableJobs.length > 0 ? ` Available jobs: ${availableJobs.join(', ')}` : ''
      }`,
    );
    this.name = 'CronJobNotFoundError';
    this.jobId = jobId;
    this.availableJobs = availableJobs;
  }
}

export class CronConcurrencyError extends CronError {
  public readonly jobId: string;

  constructor(jobId: string) {
    super(`Scheduled job "${jobId}" is already executing and does not allow concurrent runs.`);
    this.name = 'CronConcurrencyError';
    this.jobId = jobId;
  }
}

export class CronExecutionError extends CronError {
  public readonly jobId: string;
  public readonly originalError: unknown;

  constructor(jobId: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    super(`Execution of scheduled job "${jobId}" failed: ${detail}`);
    this.name = 'CronExecutionError';
    this.jobId = jobId;
    this.originalError = error;
    if (error instanceof Error && error.stack) {
      this.stack = error.stack;
    }
  }
}
