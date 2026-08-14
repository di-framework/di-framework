import { join } from 'node:path';
import { ChatAgent, type ChatModel } from '@di-framework/ai';
import { createSkillsToolbox } from '@di-framework/ai-utils';

export const exampleRoot = join(import.meta.dir, '..');

export function exampleSkillsToolbox(options: { shell?: boolean } = {}) {
  return createSkillsToolbox({
    directories: [join(exampleRoot, '.claude', 'skills')],
    workspace: exampleRoot,
    shell: options.shell ?? false,
  });
}

export function createReviewAgent(chatModel: ChatModel, options: { shell?: boolean } = {}) {
  const box = exampleSkillsToolbox(options);
  return ChatAgent.create({
    chatModel,
    system: 'You help with TypeScript code review. Use skills when they match.',
    tools: box.tools,
  });
}
