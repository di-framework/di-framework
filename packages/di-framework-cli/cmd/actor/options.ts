import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as ActorsModule from "@di-framework/actors";
import { CommandFailure } from "../../command";

export type ActorsOperations = typeof ActorsModule;

export interface ActorCliParsedOptions {
  positional: string[];
  dir?: string;
  namespace?: string;
  key?: string;
  actor?: string;
  active?: boolean;
  showState?: boolean;
  all?: boolean;
  json?: boolean;
}

export function parseActorCliArgs(args: readonly string[]): ActorCliParsedOptions {
  const options: ActorCliParsedOptions = {
    positional: [],
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";

    if (token === "--dir" || token === "--base-dir") {
      options.dir = readNextValue(args, ++i, token);
      continue;
    }
    if (token.startsWith("--dir=")) {
      options.dir = token.slice(6);
      continue;
    }
    if (token.startsWith("--base-dir=")) {
      options.dir = token.slice(11);
      continue;
    }

    if (token === "--namespace") {
      options.namespace = readNextValue(args, ++i, token);
      continue;
    }
    if (token.startsWith("--namespace=")) {
      options.namespace = token.slice(12);
      continue;
    }

    if (token === "--key") {
      options.key = readNextValue(args, ++i, token);
      continue;
    }
    if (token.startsWith("--key=")) {
      options.key = token.slice(6);
      continue;
    }

    if (token === "--actor") {
      options.actor = readNextValue(args, ++i, token);
      continue;
    }
    if (token.startsWith("--actor=")) {
      options.actor = token.slice(8);
      continue;
    }

    if (token === "--active") {
      options.active = true;
      continue;
    }

    if (token === "--show-state") {
      options.showState = true;
      continue;
    }

    if (token === "--all") {
      options.all = true;
      continue;
    }

    if (token === "--json") {
      options.json = true;
      continue;
    }

    if (token.startsWith("-")) {
      throw new CommandFailure("INVALID_USAGE", `Unknown option: ${token}`, 2, { token });
    }

    options.positional.push(token);
  }

  return options;
}

function readNextValue(args: readonly string[], index: number, flag: string): string {
  const val = args[index];
  if (!val || val.startsWith("-")) {
    throw new CommandFailure("INVALID_USAGE", `Option ${flag} requires a value`, 2, { flag });
  }
  return val;
}

export async function loadActorOperations(cwd: string = process.cwd()): Promise<ActorsOperations> {
  // 1. Try standard package import
  try {
    return (await import("@di-framework/actors")) as ActorsOperations;
  } catch {}

  // 2. Project local resolution
  try {
    const req = createRequire(resolve(cwd, "package.json"));
    const modulePath = req.resolve("@di-framework/actors");
    return (await import(pathToFileURL(modulePath).href)) as ActorsOperations;
  } catch {}

  // 3. Monorepo relative fallback
  try {
    const monorepoSource = resolve(
      import.meta.dir,
      "../../../../packages/di-framework-actors/src/index.ts",
    );
    if (existsSync(monorepoSource)) {
      return (await import(pathToFileURL(monorepoSource).href)) as ActorsOperations;
    }
  } catch {}

  throw new CommandFailure(
    "ACTORS_PACKAGE_UNAVAILABLE",
    "Unable to load @di-framework/actors from the current project",
    3,
  );
}
