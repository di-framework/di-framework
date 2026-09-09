import type { CommandResult } from "../../command";
import { runActorReset } from "./reset";

export async function runActorClean(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<CommandResult> {
  return runActorReset(args, cwd);
}
