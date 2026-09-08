/**
 * Ambient declarations for module specifiers that only exist inside a bundled
 * WebAssembly component: the virtual application entry injected by the build's
 * rolldown plugin, and the WASI HTTP interface provided by the component host.
 * Neither module resolves in this repository, so the adapter type-checks
 * against these stubs; they are not shipped in the tarball.
 */
declare module 'virtual:di-framework-application' {
  const application: unknown;
  export default application;
}

declare module 'virtual:di-framework-wasmcloud-guests' {
  export const guests: Record<string, unknown>;
}

declare module 'wasi:http/types@0.3.0' {
  export const Fields: {
    fromList(entries: Array<[string, Uint8Array]>): unknown;
  };
  export const Request: {
    consumeBody(request: unknown, res: Promise<unknown>): unknown;
  };
  export const Response: {
    new(headers: unknown, contents: unknown, trailers: Promise<unknown>): unknown;
  };
}

declare module 'wasi:sockets/types@0.3.0' {
  export const TcpSocket: {
    create(family: 'ipv4' | 'ipv6'): unknown;
  };
  export const UdpSocket: {
    create(family: 'ipv4' | 'ipv6'): unknown;
  };
}

declare module 'wasi:sockets/ip-name-lookup@0.3.0' {
  export function resolveAddresses(name: string): Promise<unknown>;
}
