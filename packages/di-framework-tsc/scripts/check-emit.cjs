#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const fixtureRoot = path.resolve(__dirname, '..', 'fixture');
const outFile = path.join(fixtureRoot, 'dist', 'greet.js');

if (!fs.existsSync(outFile)) {
  console.error(`check-emit: missing emit output at ${outFile}`);
  process.exit(1);
}

const js = fs.readFileSync(outFile, 'utf8');
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
];

const missing = required.filter((needle) => !js.includes(needle));
if (missing.length > 0) {
  console.error('check-emit: emitted JS is missing injected runtime checks:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('\n--- emit preview ---\n' + js.slice(0, 2000));
  process.exit(1);
}

console.log('check-emit: ok — runtime parameter checks present in', outFile);
