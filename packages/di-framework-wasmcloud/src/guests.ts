export type GuestModules = Record<string, unknown>;

let guests: GuestModules = {};

export function setGuests(value: GuestModules): void {
  guests = value;
}

export function resetGuests(): void {
  guests = {};
}

export function tryGetGuest<T>(name: string): T | undefined {
  return guests[name] as T | undefined;
}

export function requireGuest<T>(guest: T | undefined, name: string): T {
  if (guest === undefined) {
    throw new Error(
      `wasmCloud binding "${name}" has no guest implementation. In unit tests, pass a fake to the constructor or call setGuests().`,
    );
  }
  return guest;
}
