import { join } from 'node:path';
import { ChatAgent, type ChatModel, OpenAiChatModel, type ToolCallback } from '@di-framework/ai';
import { SkillsAgent, SkillsToolbox } from '@di-framework/ai-utils';
import {
  loadEnvSecrets as loadSharedEnvSecrets,
  requireOpenAiApiKey as requireSharedOpenAiApiKey,
} from '@di-framework/examples-shared';

export const exampleRoot = join(import.meta.dir, '..');
export const skillsDirectory = join(exampleRoot, '.claude', 'skills');
export const sampleUserPath = join(exampleRoot, 'fixtures', 'sample-user.ts');

export const REVIEW_SYSTEM =
  'You help with TypeScript code review. Before any other tool, activate the matching skill with the Skill tool (command is the skill name only). After it loads, follow its instructions exactly. Keep the review short.';

export function exampleSkillsToolbox(options: { shell?: boolean } = {}) {
  return SkillsToolbox.builder()
    .addSkillsDirectory(skillsDirectory)
    .workspace(exampleRoot)
    .shell(options.shell ?? false)
    .confirmShell(({ command }) => command.includes('count-lines.sh'))
    .build();
}

export function createReviewAgent(chatModel: ChatModel, options: { shell?: boolean } = {}) {
  return SkillsAgent.builder()
    .chatModel(chatModel)
    .system(REVIEW_SYSTEM)
    .addSkillsDirectory(skillsDirectory)
    .workspace(exampleRoot)
    .shell(options.shell ?? false)
    .confirmShell(({ command }) => command.includes('count-lines.sh'))
    .build();
}

/** Fill missing {@code process.env} keys from ancestor {@code .env.secrets}. */
export function loadEnvSecrets(startDir = exampleRoot): string | undefined {
  return loadSharedEnvSecrets(startDir);
}

/** Fail fast when the live OpenAI path is used without a key. */
export function requireOpenAiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return requireSharedOpenAiApiKey(env, env === process.env ? exampleRoot : undefined);
}

export function createOpenAiChatModel(): OpenAiChatModel {
  return new OpenAiChatModel({
    model: 'gpt-4o-mini',
    apiKey: requireOpenAiApiKey(),
  });
}

/** Preferred live wiring: {@link SkillsAgent.builder} + {@link OpenAiChatModel}. */
export function createLiveReviewAgent(chatModel: ChatModel = createOpenAiChatModel()): ChatAgent {
  requireOpenAiApiKey();
  return createReviewAgent(chatModel, { shell: true });
}

export interface LiveExampleResult {
  readonly content: string;
  readonly usedTools: readonly string[];
}

function recordToolCalls(tools: readonly ToolCallback[], used: string[]): ToolCallback[] {
  return tools.map((tool) => ({
    toolDefinition: tool.toolDefinition,
    toolMetadata: tool.toolMetadata,
    call(toolInput: string, toolContext) {
      used.push(tool.toolDefinition.name);
      return tool.call(toolInput, toolContext);
    },
  }));
}

/**
 * End-to-end review of {@link sampleUserPath}.
 * Pass a {@link ChatModel} in tests; omit it to use OpenAI via {@code process.env.OPENAI_API_KEY}.
 */
export async function runLiveExample(chatModel?: ChatModel): Promise<LiveExampleResult> {
  const model = chatModel ?? createOpenAiChatModel();
  if (!chatModel) {
    requireOpenAiApiKey();
  }

  const usedTools: string[] = [];
  const toolbox = exampleSkillsToolbox({ shell: true });
  const agent = ChatAgent.create({
    chatModel: model,
    system: REVIEW_SYSTEM,
    tools: recordToolCalls(toolbox.tools, usedTools),
  });

  const { content } = await agent.chat(
    `Call Skill with command "code-reviewer" first. Then review fixtures/sample-user.ts. Load references/checklist.md with Read before writing the review. Mention concrete issues from the checklist.`,
  );
  return { content, usedTools };
}

/** CLI main gate — `isMain` and `live` are injectable so tests can cover the entry path. */
export async function runAiSkillsMain(
  isMain = import.meta.main,
  live: () => Promise<LiveExampleResult> = runLiveExample,
): Promise<void> {
  if (!isMain) return;
  const result = await live();
  console.log(`tools: ${result.usedTools.join(', ') || '(none)'}`);
  console.log(result.content);
}

await runAiSkillsMain();
