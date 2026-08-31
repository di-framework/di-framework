interface ServiceConfig {
  endpoint: string;
  retries: number;
}

interface Request {
  id: number;
  tags: string[];
}

type Mode = 'sync' | 'async';

export class ApiService {
  constructor(private readonly config: ServiceConfig) {}

  execute({ id, tags }: Request, mode: Mode = 'sync'): [number, string] {
    return [id, `${this.config.endpoint}:${mode}:${tags.join(',')}`];
  }

  handler = async (request: Request) => this.execute(request);
}

export const createService = (config: ServiceConfig) => new ApiService(config);
