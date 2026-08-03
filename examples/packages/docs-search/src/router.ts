import { TypedRouter } from '@di-framework/http';
import type { Env } from './env';

/** Shared typed router — controllers register routes as static `@Endpoint` properties. */
export const router = TypedRouter<[Env, ExecutionContext]>();
