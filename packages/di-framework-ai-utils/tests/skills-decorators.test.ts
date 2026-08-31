import { describe, expect, test } from 'bun:test';
import { ScriptedChatModel } from '@di-framework/ai';
import {
  agentSkill,
  getDeclaredSkills,
  getSemanticSkillDiscoveryMetadata,
  getSkillsIndexMetadata,
  getSkillsMetadata,
  SemanticSkillDiscovery,
  Skill,
  Skills,
  SkillsAgent,
  skillsAgentBuilderFrom,
  SkillsIndex,
  SkillsIndexConfig,
  skillsIndexBuilderFrom,
  SkillsToolbox,
  skillsToolboxBuilderFrom,
  skillsToolboxOptionsFrom,
  type SkillEmbedder,
  type SkillTokenChunkOptions,
} from '../src/index.ts';

class FakeEmbedder implements SkillEmbedder {
  readonly id = 'fake@test';
  readonly model = 'fake';
  readonly revision = 'test';

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map(() => new Float32Array([1, 0, 0]));
  }

  async split(text: string, _options: SkillTokenChunkOptions): Promise<readonly string[]> {
    return [text];
  }
}

describe('skills decorators', () => {
  test('Skills and SemanticSkillDiscovery store metadata', () => {
    @Skills({
      directories: ['.claude/skills'],
      packages: ['@company/skills'],
      workspace: '/tmp/app',
      noDefaultDirectories: true,
    })
    @SemanticSkillDiscovery({
      indexFile: '.di-framework/skills-index.jsonl',
      limit: 10,
      minScore: 0.2,
    })
    class ApplicationSkills {}

    expect(getSkillsMetadata(ApplicationSkills)).toEqual({
      directories: ['.claude/skills'],
      packages: ['@company/skills'],
      workspace: '/tmp/app',
      noDefaultDirectories: true,
    });
    expect(getSemanticSkillDiscoveryMetadata(ApplicationSkills)).toEqual({
      indexFile: '.di-framework/skills-index.jsonl',
      limit: 10,
      minScore: 0.2,
    });
  });

  test('@Skill produces the same shape as agentSkill()', () => {
    @Skill({
      name: 'code-reviewer',
      description: 'Reviews TypeScript code.',
      content: 'Check nulls.',
    })
    class CodeReviewerSkill {}

    const declared = getDeclaredSkills(CodeReviewerSkill);
    expect(declared).toHaveLength(1);
    expect(declared[0]).toEqual(
      agentSkill({
        name: 'code-reviewer',
        description: 'Reviews TypeScript code.',
        content: 'Check nulls.',
      }),
    );
  });

  test('skillsToolboxOptionsFrom matches SkillsToolbox.builder().toOptions()', () => {
    @Skills({
      directories: ['.claude/skills'],
      packages: ['@company/skills'],
      workspace: '/tmp/app',
    })
    @SemanticSkillDiscovery({
      indexFile: '.di-framework/skills-index.jsonl',
      limit: 10,
    })
    @Skill({
      name: 'code-reviewer',
      description: 'Reviews TypeScript code.',
      content: 'Check nulls.',
    })
    class ApplicationSkills {}

    const fromDecorators = skillsToolboxOptionsFrom(ApplicationSkills);
    const fromBuilder = SkillsToolbox.builder()
      .addSkillsDirectories(['.claude/skills'])
      .addPackages(['@company/skills'])
      .workspace('/tmp/app')
      .addSkill(
        agentSkill({
          name: 'code-reviewer',
          description: 'Reviews TypeScript code.',
          content: 'Check nulls.',
        }),
      )
      .semanticDiscovery({
        indexFile: '.di-framework/skills-index.jsonl',
        limit: 10,
      })
      .toOptions();

    expect(fromDecorators).toEqual(fromBuilder);
    expect(skillsToolboxBuilderFrom(ApplicationSkills).toOptions()).toEqual(fromBuilder);
  });

  test('apply helpers accept embedder and chatModel overrides without storing them on metadata', () => {
    @Skills({ directories: ['.claude/skills'], noDefaultDirectories: true })
    @SemanticSkillDiscovery({ limit: 5 })
    class ApplicationSkills {}

    const embedder = new FakeEmbedder();
    const chatModel = new ScriptedChatModel([]);

    const options = skillsToolboxOptionsFrom(ApplicationSkills, {
      chatModel,
      semanticDiscovery: { embedder, limit: 3 },
    });

    expect(getSemanticSkillDiscoveryMetadata(ApplicationSkills)).toEqual({ limit: 5 });
    expect(options.chatModel).toBe(chatModel);
    expect(options.semanticDiscovery).toEqual({ limit: 3, embedder });

    const agentOptions = skillsAgentBuilderFrom(ApplicationSkills, {
      chatModel,
      system: 'Be concise.',
    }).toAgentOptions();
    expect(agentOptions.chatModel).toBe(chatModel);
    expect(agentOptions.system).toBe('Be concise.');
    expect(agentOptions.semanticDiscovery).toEqual({ limit: 5 });
  });

  test('skillsIndexBuilderFrom matches SkillsIndex.builder().toOptions()', () => {
    @SkillsIndexConfig({
      directories: ['.claude/skills'],
      threshold: 50,
      retrievalLimit: 10,
      outputFile: '.di-framework/skills-index.jsonl',
    })
    class ApplicationSkillsIndex {}

    expect(getSkillsIndexMetadata(ApplicationSkillsIndex)).toEqual({
      directories: ['.claude/skills'],
      threshold: 50,
      retrievalLimit: 10,
      outputFile: '.di-framework/skills-index.jsonl',
    });

    const fromDecorators = skillsIndexBuilderFrom(ApplicationSkillsIndex).toOptions();
    const fromBuilder = SkillsIndex.builder()
      .addSkillsDirectories(['.claude/skills'])
      .threshold(50)
      .retrievalLimit(10)
      .outputFile('.di-framework/skills-index.jsonl')
      .toOptions();

    expect(fromDecorators).toEqual(fromBuilder);
  });

  test('skillsAgentBuilderFrom prefilled options match SkillsAgent.builder()', () => {
    @Skills({ directories: ['skills'], noDefaultDirectories: true })
    class ApplicationSkills {}

    const model = new ScriptedChatModel([]);
    const decorated = skillsAgentBuilderFrom(ApplicationSkills, {
      chatModel: model,
      write: true,
    }).toAgentOptions();
    const handBuilt = SkillsAgent.builder()
      .addSkillsDirectories(['skills'])
      .chatModel(model)
      .write()
      .toAgentOptions();

    expect(decorated).toEqual(handBuilt);
  });

  test('noDefaultDirectories yields empty directories', () => {
    @Skills({ noDefaultDirectories: true })
    class EmptyCatalog {}

    expect(skillsToolboxOptionsFrom(EmptyCatalog).directories).toEqual([]);
    expect(skillsToolboxBuilderFrom(EmptyCatalog).toOptions().directories).toEqual([]);
  });
});
