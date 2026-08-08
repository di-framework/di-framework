#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function findTtscJs(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'ttsc', 'lib', 'launcher', 'ttsc.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const args = process.argv.slice(2);
const ttscJs = findTtscJs(process.cwd());

let result;
if (ttscJs) {
  result = spawnSync(process.execPath, [ttscJs, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
} else {
  result = spawnSync('ttsc', args, {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.error && result.error.code === 'ENOENT') {
    console.error(
      'dtsc: could not find ttsc. Install it in this project (`npm i -D ttsc`) or on PATH.',
    );
    process.exit(1);
  }
}

if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
