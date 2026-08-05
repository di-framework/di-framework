import registry, { type RpcRegistry } from '../registry.ts';
import type {
  RpcConstructor,
  RpcFieldMetadata,
  RpcMessageMetadata,
  RpcScalarType,
} from '../types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function metadataFor(target: RpcConstructor, source: RpcRegistry): RpcMessageMetadata {
  const metadata = source.getMessage(target);
  if (!metadata) throw new Error(`${target.name} is not decorated with @RpcMessage`);
  return metadata;
}

function fieldType(field: RpcFieldMetadata): RpcScalarType | RpcConstructor {
  if (!field.type) return 'string';
  return typeof field.type === 'function' ? field.type() : field.type;
}

function encodeVarint(value: number | bigint): number[] {
  let current = BigInt(value);
  if (current < 0) current = BigInt.asUintN(64, current);
  const bytes: number[] = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (current > 0n);
  return bytes;
}

function readVarint(bytes: Uint8Array, offset: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < bytes.length && shift <= 70n) {
    const byte = bytes[cursor++];
    if (byte === undefined) break;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, cursor];
    shift += 7n;
  }
  throw new Error('Invalid protobuf varint');
}

function wireType(type: RpcScalarType | RpcConstructor): number {
  if (type === 'bool' || type === 'int32' || type === 'int64') return 0;
  if (type === 'double') return 1;
  return 2;
}

function encodeOne(field: RpcFieldMetadata, value: unknown, source: RpcRegistry): number[] {
  const type = fieldType(field);
  const wire = wireType(type);
  const out = [...encodeVarint((field.number << 3) | wire)];
  if (type === 'bool') return [...out, ...encodeVarint(value ? 1 : 0)];
  if (type === 'int32' || type === 'int64') {
    return [...out, ...encodeVarint(typeof value === 'bigint' ? value : Number(value))];
  }
  if (type === 'double') {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, Number(value), true);
    return [...out, ...new Uint8Array(buffer)];
  }

  let data: Uint8Array;
  if (type === 'bytes') {
    data =
      value instanceof Uint8Array
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array();
  } else if (type === 'string') {
    data = encoder.encode(String(value));
  } else {
    data = encodeRpcMessage(type, value as Record<string, unknown>, source);
  }
  return [...out, ...encodeVarint(data.length), ...data];
}

/** Encode a decorated message using the protobuf binary wire format. */
export function encodeRpcMessage(
  target: RpcConstructor,
  value: Record<string, unknown>,
  source: RpcRegistry = registry,
): Uint8Array {
  const metadata = metadataFor(target, source);
  const bytes: number[] = [];
  for (const field of [...metadata.fields].sort((a, b) => a.number - b.number)) {
    const fieldValue = value[field.propertyKey];
    if (fieldValue === undefined || fieldValue === null) continue;
    if (field.repeated) {
      if (!Array.isArray(fieldValue)) {
        throw new Error(`${metadata.name}.${field.propertyKey} must be an array`);
      }
      for (const item of fieldValue) bytes.push(...encodeOne(field, item, source));
    } else {
      bytes.push(...encodeOne(field, fieldValue, source));
    }
  }
  return Uint8Array.from(bytes);
}

function decodeOne(
  type: RpcScalarType | RpcConstructor,
  wire: number,
  bytes: Uint8Array,
  offset: number,
  source: RpcRegistry,
): [unknown, number] {
  if (wire === 0) {
    const [raw, next] = readVarint(bytes, offset);
    if (type === 'bool') return [raw !== 0n, next];
    if (type === 'int64') {
      return [raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw, next];
    }
    return [Number(BigInt.asIntN(32, raw)), next];
  }
  if (wire === 1 && type === 'double') {
    if (offset + 8 > bytes.length) throw new Error('Truncated protobuf double');
    return [
      new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getFloat64(0, true),
      offset + 8,
    ];
  }
  if (wire === 2) {
    const [length, start] = readVarint(bytes, offset);
    const end = start + Number(length);
    if (end > bytes.length) throw new Error('Truncated protobuf field');
    const data = bytes.subarray(start, end);
    if (type === 'string') return [decoder.decode(data), end];
    if (type === 'bytes') return [data.slice(), end];
    if (typeof type === 'function') return [decodeRpcMessage(type, data, source), end];
  }
  throw new Error(`Unsupported protobuf wire type ${wire}`);
}

function skipField(wire: number, bytes: Uint8Array, offset: number): number {
  if (wire === 0) return readVarint(bytes, offset)[1];
  if (wire === 1) return offset + 8;
  if (wire === 2) {
    const [length, start] = readVarint(bytes, offset);
    return start + Number(length);
  }
  if (wire === 5) return offset + 4;
  throw new Error(`Unsupported protobuf wire type ${wire}`);
}

/** Decode protobuf binary into an instance of a decorated message class. */
export function decodeRpcMessage<T>(
  target: RpcConstructor<T>,
  bytes: Uint8Array,
  source: RpcRegistry = registry,
): T {
  const metadata = metadataFor(target, source);
  const result = Object.create(target.prototype) as Record<string, unknown>;
  const fields = new Map(metadata.fields.map((field) => [field.number, field]));
  let offset = 0;
  while (offset < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, offset);
    offset = afterTag;
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    const field = fields.get(number);
    if (!field) {
      offset = skipField(wire, bytes, offset);
      continue;
    }
    const [value, next] = decodeOne(fieldType(field), wire, bytes, offset, source);
    offset = next;
    if (field.repeated) {
      const values = (result[field.propertyKey] as unknown[] | undefined) ?? [];
      values.push(value);
      result[field.propertyKey] = values;
    } else {
      result[field.propertyKey] = value;
    }
  }
  return result as T;
}

/** Hydrate a proto-JSON object so service methods receive class instances. */
export function hydrateRpcMessage<T>(
  target: RpcConstructor<T>,
  input: unknown,
  source: RpcRegistry = registry,
): T {
  const metadata = metadataFor(target, source);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${metadata.name} input must be an object`);
  }
  const instance = Object.create(target.prototype) as Record<string, unknown>;
  for (const field of metadata.fields) {
    let value = (input as Record<string, unknown>)[field.propertyKey];
    const type = fieldType(field);
    if (typeof type === 'function' && value !== undefined) {
      value = field.repeated
        ? (value as unknown[]).map((item) => hydrateRpcMessage(type, item, source))
        : hydrateRpcMessage(type, value, source);
    } else if (type === 'bytes' && typeof value === 'string') {
      value = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    }
    if (value !== undefined) instance[field.propertyKey] = value;
  }
  return instance as T;
}

/** Convert a decorated message to proto3-compatible JSON. */
export function rpcMessageToJson(
  target: RpcConstructor,
  value: unknown,
  source: RpcRegistry = registry,
): Record<string, unknown> {
  const metadata = metadataFor(target, source);
  const record = (value ?? {}) as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const field of metadata.fields) {
    let fieldValue = record[field.propertyKey];
    if (fieldValue === undefined) continue;
    const type = fieldType(field);
    const map = (item: unknown): unknown => {
      if (typeof type === 'function') return rpcMessageToJson(type, item, source);
      if (type === 'bytes' && item instanceof Uint8Array) {
        return btoa(String.fromCharCode(...item));
      }
      if (typeof item === 'bigint') return item.toString();
      return item;
    };
    fieldValue = field.repeated ? (fieldValue as unknown[]).map(map) : map(fieldValue);
    output[field.propertyKey] = fieldValue;
  }
  return output;
}

function protoType(field: RpcFieldMetadata, source: RpcRegistry): string {
  const type = fieldType(field);
  if (typeof type !== 'function') return type === 'bool' ? 'bool' : type;
  return metadataFor(type, source).name;
}

/** Print the decorator registry as inspectable protobuf IDL. */
export function printProto(source: RpcRegistry = registry): string {
  const packages = new Map<string, ReturnType<RpcRegistry['getServices']>>();
  for (const service of source.getServices()) {
    const list = packages.get(service.package) ?? [];
    list.push(service);
    packages.set(service.package, list);
  }
  const files: string[] = [];
  for (const [packageName, services] of packages) {
    const sections = [`syntax = "proto3";`, `package ${packageName};`];
    for (const message of source.messagesForPackage(packageName)) {
      sections.push(
        `message ${message.name} {\n${[...message.fields]
          .sort((a, b) => a.number - b.number)
          .map(
            (field) =>
              `  ${field.repeated ? 'repeated ' : ''}${protoType(field, source)} ${field.propertyKey} = ${field.number};`,
          )
          .join('\n')}\n}`,
      );
    }
    sections.push('message RpcEmpty {}');
    for (const service of services) {
      sections.push(
        `service ${service.name} {\n${service.methods
          .map((method) => {
            const input = metadataFor(method.input(), source).name;
            const output = method.output ? metadataFor(method.output(), source).name : 'RpcEmpty';
            return `  rpc ${method.name} (${input}) returns (${output});`;
          })
          .join('\n')}\n}`,
      );
    }
    files.push(sections.join('\n\n'));
  }
  if (files.length === 0) {
    return 'syntax = "proto3";\n';
  }
  return `${files.join('\n\n// ---- next generated file ----\n\n')}\n`;
}
