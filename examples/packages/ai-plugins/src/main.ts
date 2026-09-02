import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentPlugin,
  type AgentPluginMcpServer,
  loadPluginDirectory,
  resolvePluginPackageDirectories,
  validatePluginCatalog,
} from '@di-framework/ai-utils';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const exampleRoot = join(import.meta.dir, '..');
export const OFFICIAL_PLUGIN_PACKAGE = '@di-framework/plugin';

/** Expand `${pluginDir}` placeholders used by the official plugin mcp_config.json. */
export function expandPluginDirPlaceholders(value: string, pluginDir: string): string {
  return value.split('${pluginDir}').join(pluginDir);
}

/** Resolve stdio command + args for one plugin MCP server entry. */
export function resolvePluginMcpStdioLaunch(
  plugin: AgentPlugin,
  serverName: string,
): {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
} {
  const server = plugin.mcpConfig?.mcpServers[serverName];
  if (server == null) {
    throw new Error(`Plugin "${plugin.name}" has no MCP server named "${serverName}"`);
  }
  return resolveMcpStdioLaunch(server, plugin.basePath);
}

export function resolveMcpStdioLaunch(
  server: AgentPluginMcpServer,
  pluginDir: string,
): {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
} {
  if (server.command == null || server.command.trim() === '') {
    throw new Error('MCP server entry requires a stdio command');
  }
  const args = (server.args ?? []).map((arg) => expandPluginDirPlaceholders(arg, pluginDir));
  const cwd = server.cwd == null ? undefined : expandPluginDirPlaceholders(server.cwd, pluginDir);
  return {
    command: expandPluginDirPlaceholders(server.command, pluginDir),
    args,
    cwd,
    env: server.env == null ? undefined : { ...server.env },
  };
}

/** Discover and validate the published {@link OFFICIAL_PLUGIN_PACKAGE}. */
export function loadOfficialPluginCatalog(workspace = exampleRoot) {
  return validatePluginCatalog({
    workspace,
    packages: [OFFICIAL_PLUGIN_PACKAGE],
    sourceMode: 'replace',
  });
}

/** Resolve the installed package root and load it as a single plugin bundle. */
export function loadOfficialPlugin(
  workspace = exampleRoot,
  resolveDirs: typeof resolvePluginPackageDirectories = resolvePluginPackageDirectories,
): AgentPlugin {
  const [pluginRoot] = resolveDirs([OFFICIAL_PLUGIN_PACKAGE], workspace);
  if (pluginRoot == null) {
    throw new Error(
      `Could not resolve ${OFFICIAL_PLUGIN_PACKAGE} as a plugin package from ${workspace}`,
    );
  }
  return loadPluginDirectory(pluginRoot);
}

export interface OfficialPluginMcpSession {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly toolNames: readonly string[];
  close(): Promise<void>;
}

/**
 * Elective MCP wiring: spawn the plugin's stdio MCP server and list tools.
 * Uses only the published plugin binary — no API keys required for local tools.
 */
export async function connectOfficialPluginMcp(
  plugin: AgentPlugin = loadOfficialPlugin(),
  serverName = 'di-framework-mcp',
): Promise<OfficialPluginMcpSession> {
  const launch = resolvePluginMcpStdioLaunch(plugin, serverName);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: [...launch.args],
    cwd: launch.cwd,
    env: launch.env,
  });
  const client = new Client({ name: 'ai-plugins-example', version: '0.0.0' });
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  return {
    client,
    transport,
    toolNames,
    async close() {
      await client.close();
    },
  };
}

export interface LiveExampleResult {
  readonly pluginName: string;
  readonly skillNames: readonly string[];
  readonly ruleNames: readonly string[];
  readonly mcpServers: readonly string[];
  readonly toolNames: readonly string[];
  readonly scaffoldPreview: string;
}

export function listPluginSkillNames(plugin: AgentPlugin): string[] {
  if (plugin.skillsDirectory == null) return [];
  try {
    return readdirSync(plugin.skillsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Validate the official plugin, connect its MCP, and call the keyless
 * {@code di_scaffold_provider} tool.
 */
export async function runLiveExample(
  connect: typeof connectOfficialPluginMcp = connectOfficialPluginMcp,
  loadCatalog: typeof loadOfficialPluginCatalog = loadOfficialPluginCatalog,
): Promise<LiveExampleResult> {
  const catalog = loadCatalog();
  if (!catalog.valid) {
    throw new Error(catalog.diagnostics.map((d) => d.message).join('\n'));
  }
  const plugin = catalog.plugins[0];
  if (plugin == null) {
    throw new Error(`Expected ${OFFICIAL_PLUGIN_PACKAGE} in the validated catalog`);
  }

  const session = await connect(plugin);
  try {
    const scaffold = await session.client.callTool({
      name: 'di_scaffold_provider',
      arguments: { serviceName: 'GreetingService', lifecycle: 'Singleton' },
    });
    const scaffoldPreview = JSON.stringify(scaffold.content ?? scaffold, null, 2);
    return {
      pluginName: plugin.name,
      skillNames: listPluginSkillNames(plugin),
      ruleNames: plugin.rules.map((rule) => rule.name),
      mcpServers: Object.keys(plugin.mcpConfig?.mcpServers ?? {}),
      toolNames: session.toolNames,
      scaffoldPreview,
    };
  } finally {
    await session.close();
  }
}

/** CLI main gate — {@code isMain} and {@code live} are injectable for tests. */
export async function runAiPluginsMain(
  isMain = import.meta.main,
  live: () => Promise<LiveExampleResult> = runLiveExample,
): Promise<void> {
  if (!isMain) return;
  const result = await live();
  console.log(`plugin: ${result.pluginName}`);
  console.log(`skills: ${result.skillNames.join(', ') || '(none)'}`);
  console.log(`rules: ${result.ruleNames.join(', ') || '(none)'}`);
  console.log(`mcp: ${result.mcpServers.join(', ') || '(none)'}`);
  console.log(`tools: ${result.toolNames.join(', ') || '(none)'}`);
  console.log(result.scaffoldPreview);
}

await runAiPluginsMain();
