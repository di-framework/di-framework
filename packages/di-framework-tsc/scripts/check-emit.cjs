#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const fixtureRoot = path.resolve(__dirname, '..', 'fixture');
const outFile = path.join(fixtureRoot, 'dist', 'greet.js');
const serviceOutFile = path.join(fixtureRoot, 'dist', 'service.js');
const nominalOutFile = path.join(fixtureRoot, 'dist', 'nominal.js');

if (!fs.existsSync(outFile)) {
  console.error(`check-emit: missing emit output at ${outFile}`);
  process.exit(1);
}

const js = fs.readFileSync(outFile, 'utf8');
if (!fs.existsSync(serviceOutFile)) {
  console.error(`check-emit: missing emit output at ${serviceOutFile}`);
  process.exit(1);
}
const serviceJs = fs.readFileSync(serviceOutFile, 'utf8');
if (!fs.existsSync(nominalOutFile)) {
  console.error(`check-emit: missing emit output at ${nominalOutFile}`);
  process.exit(1);
}
const nominalJs = fs.readFileSync(nominalOutFile, 'utf8');
const required = [
  'typeof user !== "object"',
  'Expected user to be an object',
  'typeof user.id !== "number"',
  'Expected user.id to be a number',
  'typeof user.name !== "string"',
  'Expected user.name to be a string',
  'typeof a !== "number"',
  'typeof b !== "number"',
  'class Greeter',
  'typeof prefix !== "string"',
  'typeof value !== "number"',
  'typeof by !== "number"',
  'typeof enabled !== "boolean"',
  'async (value) => {',
  'return value + 1',
  'state !== "active"',
  'count !== 0',
  'enabled !== true',
  'absent !== null',
  'missing !== undefined',
  'Expected value to match its union type',
  'Expected nullable to match its union type',
  'Expected result to match its union type',
  '!Array.isArray(numbers)',
  'numbers.some(__di_item => typeof __di_item !== "number")',
  '!Array.isArray(users)',
  'typeof __di_item.id !== "number"',
  'pair.length !== 2',
  'typeof pair[0] !== "number"',
  'typeof pair[1] !== "string"',
  'typeof nested[1].id !== "number"',
  'optional.length < 1',
  'optional.length > 2',
  'if (label !== undefined)',
  'typeof label !== "string"',
  'if (count !== undefined)',
  '!("left" in value)',
  'typeof value.shared !== "number"',
  '!("right" in value)',
  '!("x-id" in nested.item)',
  'nested.item["x-id"] !== undefined',
  '!Array.isArray(entries)',
  '!("left" in __di_item)',
  'typeof __di_item.right !== "string"',
  'Object.keys(indexed).some(__di_key => typeof indexed[__di_key] !== "number")',
  'Object.keys(record).some(__di_key => typeof record[__di_key] !== "number")',
  'Object.keys(values).some(__di_key => typeof values[__di_key] !== "object"',
  'Object.keys(values[__di_key]).some(__di_key_1 => typeof values[__di_key][__di_key_1] !== "number")',
  'Object.keys(__di_key).some(__di_key_1 => typeof __di_key[__di_key_1] !== "number")',
  '!("x-id" in fixed)',
  'typeof fixed["x-id"] !== "number"',
  '!("" in special)',
  'typeof special[""] !== "number"',
  '!("__id" in special)',
  'typeof special.__id !== "number"',
  'typeof userId !== "string"',
  'typeof accountId !== "number"',
  'enabled !== false && enabled !== true',
  'typeof sequence !== "bigint"',
  'role !== "admin"',
  'apiVersion !== 1',
  'firstSequence !== 1n',
  'typeof route !== "string"',
  '!route.startsWith("user_")',
  '!artifact.endsWith("_done")',
  '!wrapped.startsWith("v_")',
  '!wrapped.endsWith("_end")',
  'typeof complex !== "string"',
  'typeof numeric !== "string"',
  '__di_item.startsWith("user_")',
  '!Array.isArray(values)',
  'values.some(__di_item => typeof __di_item !== "number")',
  'typeof id !== "number"',
  'typeof name !== "string"',
  'typeof count !== "number"',
  'typeof label !== "string"',
];

const missing = required.filter((needle) => !js.includes(needle));
const serviceRequired = [
  'class ApiService',
  'typeof config.endpoint !== "string"',
  'typeof config.retries !== "number"',
  'typeof id !== "number"',
  '!Array.isArray(tags)',
  'Expected mode to match its union type',
  'const createService = (config) => {',
];
missing.push(...serviceRequired.filter((needle) => !serviceJs.includes(needle)));
const sharedChecks = js.split('typeof value.shared !== "number"').length - 1;
if (sharedChecks !== 1) {
  missing.push(`intersection shared-property check exactly once (found ${sharedChecks})`);
}
const forbidden = [
  'typeof value.label !== "string"',
  'Object.keys(numericValues).some(__di_key',
  'Object.keys(unsupportedValues).some(__di_key',
  'Object.keys(symbolValues).some(__di_key',
  'Expected callable to be an object',
  'Expected constructable to be an object',
  'Expected requiredRecursive to be an object',
  'Object.keys(recursiveIndex).some(',
  'userId.__brand',
  'accountId.__brand',
  'enabled.__brand',
  'sequence.__brand',
  'role.__brand',
  'apiVersion.__brand',
  'firstSequence.__brand',
  'complex.startsWith(',
  'complex.endsWith(',
  'numeric.startsWith(',
  'numeric.endsWith(',
  'typeof lengthValue !== "string"',
  'typeof dateValue !== "string"',
  'typeof callableValue !== "string"',
];
for (const needle of forbidden) {
  if (js.includes(needle)) missing.push(`unexpected emitted check: ${needle}`);
}

const nominalRequired = [
  'value !== 0 && value !== 2',
  'value !== "ready" && value !== "done"',
  'value !== 10 && value !== 20',
  'Expected value to be a valid enum value',
  '!(token instanceof Token)',
  'Expected token to be an instance of Token',
  'tokens.some(__di_item => !(__di_item instanceof Token))',
  '!(value instanceof Token)',
  '!(token instanceof Domain.NamespacedToken)',
  'typeof token !== "object"',
  'typeof token.value !== "string"',
];
missing.push(...nominalRequired.filter((needle) => !nominalJs.includes(needle)));

const functionBody = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
};
const computedBody = functionBody(nominalJs, 'computedEnum');
const classBody = functionBody(nominalJs, 'useToken');
const interfaceBody = functionBody(nominalJs, 'useTokenShape');
const typeOnlyBody = functionBody(nominalJs, 'typeOnlyToken');
const importedBody = functionBody(nominalJs, 'importedToken');
const nominalForbidden = [];
if (computedBody.includes('TypeError')) nominalForbidden.push('guard for computedEnum');
if (classBody.includes('typeof token.value'))
  nominalForbidden.push('structural guard for class Token');
if (interfaceBody.includes('instanceof'))
  nominalForbidden.push('nominal guard for TokenShape interface');
if (typeOnlyBody.includes('instanceof') || typeOnlyBody.includes('ExternalToken')) {
  nominalForbidden.push('runtime reference for type-only ExternalToken import');
}
if (importedBody.includes('instanceof') || importedBody.includes('ImportedToken')) {
  nominalForbidden.push('runtime reference for type-position ImportedToken value import');
}
if (nominalJs.includes('require("./external-token.js")')) {
  nominalForbidden.push('retained external-token import used only in type positions');
}
if (nominalForbidden.length > 0) {
  console.error('check-emit: emitted JS contains forbidden partial or structural checks:');
  for (const item of nominalForbidden) console.error(`  - ${item}`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error('check-emit: emitted JS is missing injected runtime checks:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('\n--- emit preview ---\n' + js.slice(0, 2000));
  process.exit(1);
}

console.log('check-emit: ok — runtime parameter checks present in', outFile);
