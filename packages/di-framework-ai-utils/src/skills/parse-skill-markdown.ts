/**
 * SKILL.md front matter + body, aligned with Spring AI {@code MarkdownParser}
 * and the Agent Skills spec (name + description at minimum).
 */

export interface AgentSkill {
  readonly name: string;
  readonly description?: string;
  readonly basePath: string;
  readonly frontMatter: Readonly<Record<string, string>>;
  readonly content: string;
}

export interface ParseSkillMarkdownOptions {
  readonly basePath?: string;
  readonly fallbackName?: string;
}

export interface AgentSkillCreateOptions {
  readonly name: string;
  readonly description?: string;
  readonly content: string;
  readonly basePath?: string;
  readonly frontMatter?: Readonly<Record<string, string>>;
}

/**
 * Build an in-memory skill (no filesystem).
 */
export function agentSkill(options: AgentSkillCreateOptions): AgentSkill {
  const name = options.name.trim();
  if (!name) {
    throw new Error('Skill name is required');
  }
  const frontMatter: Record<string, string> = {
    ...options.frontMatter,
    name,
  };
  if (options.description != null) {
    frontMatter.description = options.description;
  }
  return {
    name,
    description: options.description ?? options.frontMatter?.description,
    basePath: options.basePath ?? '.',
    frontMatter,
    content: options.content,
  };
}

/**
 * Parse a SKILL.md document. Front matter is optional {@code ---} YAML of
 * {@code key: value} lines (quoted or unquoted). Nested YAML is not supported.
 */
export function parseSkillMarkdown(
  markdown: string,
  options: ParseSkillMarkdownOptions = {},
): AgentSkill {
  const { frontMatter, content } = splitFrontMatter(markdown ?? '');
  const name = (frontMatter.name ?? options.fallbackName ?? '').trim();
  if (!name) {
    throw new Error('SKILL.md is missing a name (front matter or folder name)');
  }
  return {
    name,
    description: frontMatter.description,
    basePath: options.basePath ?? '.',
    frontMatter: { ...frontMatter, name },
    content,
  };
}

function splitFrontMatter(markdown: string): {
  frontMatter: Record<string, string>;
  content: string;
} {
  if (!markdown.startsWith('---')) {
    return { frontMatter: {}, content: markdown };
  }

  const endIndex = markdown.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontMatter: {}, content: markdown };
  }

  const section = markdown.slice(3, endIndex).trim();
  const content = markdown.slice(endIndex + 3).trim();
  return { frontMatter: parseFrontMatter(section), content };
}

function parseFrontMatter(section: string): Record<string, string> {
  const frontMatter: Record<string, string> = {};
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = stripQuotes(line.slice(colonIndex + 1).trim());
    frontMatter[key] = value;
  }
  return frontMatter;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const start = value[0];
    const end = value[value.length - 1];
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
