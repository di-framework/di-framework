export function boot() {
  return registerAuth({ secret: 'short-secret' });
}

declare function registerAuth(options: { secret: string }): unknown;
