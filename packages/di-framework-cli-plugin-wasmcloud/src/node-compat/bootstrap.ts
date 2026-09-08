import './fetch-runtime.js';
import { installAsyncContext } from './async-hooks.js';
import timers from './timers.js';

installAsyncContext();
const global = globalThis as Record<string, unknown>;
for (const [name, implementation] of Object.entries(timers)) {
  if (typeof global[name] !== 'function') global[name] = implementation;
}
