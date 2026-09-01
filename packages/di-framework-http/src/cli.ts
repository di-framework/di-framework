#!/usr/bin/env bun
import { generateOpenAPIDocument, writeOpenAPIDocument } from './openapi.ts';

const args = process.argv.slice(2);
const command = args[0];

if (command === 'generate') {
  const outputArg = args.indexOf('--output');
  const outputPath = outputArg !== -1 ? (args[outputArg + 1] ?? 'openapi.json') : 'openapi.json';

  const controllersArg = args.indexOf('--controllers');
  const controllersPath = controllersArg === -1 ? undefined : args[controllersArg + 1];
  if (!controllersPath) {
    console.error('Error: --controllers path is required');
    process.exit(1);
  }
  const controllerModule = controllersPath;

  async function run() {
    try {
      const result = await generateOpenAPIDocument({
        controllerModules: [controllerModule],
        configuration: {
          title: 'API Documentation',
        },
      });
      writeOpenAPIDocument(result.document, outputPath);
      console.log(`Successfully generated OpenAPI spec at ${outputPath}`);
    } catch (error: unknown) {
      console.error(
        `Error generating OpenAPI spec: ${error instanceof Error ? error.message : String(error)}`,
      );
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
