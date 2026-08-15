#!/usr/bin/env node

import { runSkillsIndexCli } from './skills/skills-index-cli.ts';

runSkillsIndexCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
