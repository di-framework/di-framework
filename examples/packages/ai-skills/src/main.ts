import { join } from 'node:path';
import type { ChatModel } from '@di-framework/ai';
import { SkillsAgent, SkillsToolbox } from '@di-framework/ai-utils';

export const exampleRoot = join(import.meta.dir, '..');

export function exampleSkillsToolbox(options: { shell?: boolean } = {}) {
  return SkillsToolbox.builder()
    .addSkillsDirectory(join(exampleRoot, '.claude', 'skills'))
    .workspace(exampleRoot)
    .shell(options.shell ?? false)
    .build();
}

export function createReviewAgent(chatModel: ChatModel, options: { shell?: boolean } = {}) {
  return SkillsAgent.builder()
    .chatModel(chatModel)
    .system('You help with TypeScript code review. Use skills when they match.')
    .addSkillsDirectory(join(exampleRoot, '.claude', 'skills'))
    .workspace(exampleRoot)
    .shell(options.shell ?? false)
    .build();
}
