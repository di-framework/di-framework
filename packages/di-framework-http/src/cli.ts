#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { generateOpenAPI } from './openapi.ts';
import registry from './registry.ts';

const args = process.argv.slice(2);
const command = args[0];

if (command === 'generate') {
  const outputArg = args.indexOf('--output');
  const outputPath = outputArg !== -1 ? args[outputArg + 1] : 'openapi.json';

  const controllersArg = args.indexOf('--controllers');
  if (controllersArg === -1) {
    console.error('Error: --controllers path is required');
    process.exit(1);
  }

  async function run() {
    try {
      // Import the user's controllers to trigger decorator registration
      const controllersPathResolved = path.resolve(process.cwd(), args[controllersArg + 1]!);
      await import(controllersPathResolved);

      const spec = generateOpenAPI(
        {
          title: 'API Documentation',
        },
        registry,
      );

      fs.writeFileSync(outputPath!, JSON.stringify(spec, null, 2));
      console.log(`Successfully generated OpenAPI spec at ${outputPath}`);
    } catch (error: any) {
      console.error(`Error generating OpenAPI spec: ${error.message}`);
      process.exit(1);
    }
  }

  run();
} else {
  console.log(`
Usage: di-framework-http generate --controllers <path-to-controllers> [options]

Options:
  --controllers <path>  Path to a file that imports all your decorated controllers
  --output <path>       Path to save the generated JSON (default: openapi.json)
    `);
}
