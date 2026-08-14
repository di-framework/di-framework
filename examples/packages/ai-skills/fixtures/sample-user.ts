export interface SampleUser {
  readonly name?: string;
}

/** Intentional review target: null / undefined access. */
export function displayName(user: SampleUser | null): string {
  return user.name.toUpperCase();
}

export function greetAll(users: SampleUser[]): string[] {
  const first = users[0];
  return [first.name.trim()];
}
