import { create, createFileRegistry, type DescMessage, type DescService } from '@bufbuild/protobuf';
import {
  DescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldDescriptorProtoSchema,
  FileDescriptorProtoSchema,
  MethodDescriptorProtoSchema,
  ServiceDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
import registry, { type RpcRegistry } from '../registry.ts';
import type {
  RpcConstructor,
  RpcFieldMetadata,
  RpcScalarType,
  RpcServiceMetadata,
} from '../types.ts';

export interface CompiledConnectSchema {
  services: Map<RpcServiceMetadata, DescService>;
  messages: Map<string, DescMessage>;
}

function resolvedType(field: RpcFieldMetadata): RpcScalarType | RpcConstructor {
  if (!field.type) return 'string';
  return typeof field.type === 'function' ? field.type() : field.type;
}

function scalarDescriptorType(type: RpcScalarType): FieldDescriptorProto_Type {
  switch (type) {
    case 'bool':
      return FieldDescriptorProto_Type.BOOL;
    case 'int32':
      return FieldDescriptorProto_Type.INT32;
    case 'int64':
      return FieldDescriptorProto_Type.INT64;
    case 'double':
      return FieldDescriptorProto_Type.DOUBLE;
    case 'bytes':
      return FieldDescriptorProto_Type.BYTES;
    default:
      return FieldDescriptorProto_Type.STRING;
  }
}

/** Compile decorator metadata into protobuf-es runtime descriptors. */
export function compileConnectSchema(source: RpcRegistry = registry): CompiledConnectSchema {
  const services = new Map<RpcServiceMetadata, DescService>();
  const messages = new Map<string, DescMessage>();
  const packageNames = new Set(source.getServices().map((service) => service.package));

  for (const packageName of packageNames) {
    const packageServices = source
      .getServices()
      .filter((service) => service.package === packageName);
    const packageMessages = source.messagesForPackage(packageName);
    const messageProtos = packageMessages.map((message) =>
      create(DescriptorProtoSchema, {
        name: message.name,
        field: [...message.fields]
          .sort((a, b) => a.number - b.number)
          .map((field) => {
            const type = resolvedType(field);
            const isMessage = typeof type === 'function';
            const nestedName = isMessage ? source.getMessage(type)?.name : undefined;
            if (isMessage && !nestedName) {
              throw new Error(
                `${message.name}.${field.propertyKey}: nested type is not decorated with @RpcMessage`,
              );
            }
            return create(FieldDescriptorProtoSchema, {
              name: field.propertyKey,
              jsonName: field.propertyKey,
              number: field.number,
              label: field.repeated
                ? FieldDescriptorProto_Label.REPEATED
                : FieldDescriptorProto_Label.OPTIONAL,
              type: isMessage ? FieldDescriptorProto_Type.MESSAGE : scalarDescriptorType(type),
              typeName: isMessage ? `.${packageName}.${nestedName}` : undefined,
            });
          }),
      }),
    );
    messageProtos.push(create(DescriptorProtoSchema, { name: 'RpcEmpty' }));

    const serviceProtos = packageServices.map((service) =>
      create(ServiceDescriptorProtoSchema, {
        name: service.name,
        method: service.methods.map((method) => {
          const input = source.getMessage(method.input());
          const output = method.output ? source.getMessage(method.output()) : undefined;
          if (!input) {
            throw new Error(
              `${service.name}.${method.name}: input is not decorated with @RpcMessage`,
            );
          }
          if (method.output && !output) {
            throw new Error(
              `${service.name}.${method.name}: output is not decorated with @RpcMessage`,
            );
          }
          return create(MethodDescriptorProtoSchema, {
            name: method.name,
            inputType: `.${packageName}.${input.name}`,
            outputType: `.${packageName}.${output?.name ?? 'RpcEmpty'}`,
          });
        }),
      }),
    );

    const file = create(FileDescriptorProtoSchema, {
      name: `${packageName.replaceAll('.', '/')}/rpc.proto`,
      package: packageName,
      syntax: 'proto3',
      messageType: messageProtos,
      service: serviceProtos,
    });
    const fileRegistry = createFileRegistry(file, () => undefined);

    for (const message of packageMessages) {
      const descriptor = fileRegistry.getMessage(`${packageName}.${message.name}`);
      if (descriptor) messages.set(`${packageName}.${message.name}`, descriptor);
    }
    const empty = fileRegistry.getMessage(`${packageName}.RpcEmpty`);
    if (empty) messages.set(`${packageName}.RpcEmpty`, empty);
    for (const service of packageServices) {
      const descriptor = fileRegistry.getService(`${packageName}.${service.name}`);
      if (!descriptor) throw new Error(`Failed to compile ${packageName}.${service.name}`);
      services.set(service, descriptor);
    }
  }

  return { services, messages };
}
