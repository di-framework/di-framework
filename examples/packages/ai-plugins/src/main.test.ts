import { expect, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  expandPluginDirPlaceholders,
  loadOfficialPlugin,
  loadOfficialPluginCatalog,
  OFFICIAL_PLUGIN_PACKAGE,
  resolveMcpStdioLaunch,
  resolvePluginMcpStdioLaunch,
  runAiPluginsMain,
  runLiveExample,
} from './main.ts';

const require = createRequire(join(import.meta.dir, '..', 'package.json'));
const officialPluginRoot = dirname(require.resolve(`${OFFICIAL_PLUGIN_PACKAGE}/package.json`));

test('resolvePluginPackageDirectories finds the published root plugin.json package', () => {
  const plugin = loadOfficialPlugin();
  expect(plugin.name).toBe('di-framework');
  expect(plugin.basePath).toBe(officialPluginRoot);
  expect(plugin.skillsDirectory).toBe(join(officialPluginRoot, 'skills'));
  expect(plugin.rules.map((rule) => rule.name)).toContain('AGENTS');
  expect(Object.keys(plugin.mcpConfig?.mcpServers ?? {})).toEqual(['di-framework-mcp']);
});

test('validatePluginCatalog accepts the official plugin via packages', () => {
  const catalog = loadOfficialPluginCatalog();
  expect(catalog.valid).toBe(true);
  expect(catalog.plugins.map((plugin) => plugin.name)).toEqual(['di-framework']);
  expect(catalog.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
});

test('expands ${pluginDir} placeholders for the official mcp_config.json', () => {
  const plugin = loadOfficialPlugin();
  expect(expandPluginDirPlaceholders('${pluginDir}/dist/index.js', '/tmp/plugin')).toBe(
    '/tmp/plugin/dist/index.js',
  );
  const launch = resolvePluginMcpStdioLaunch(plugin, 'di-framework-mcp');
  expect(launch.command).toBe('node');
  expect(launch.args).toEqual([join(plugin.basePath, 'dist', 'index.js')]);
  expect(() => resolvePluginMcpStdioLaunch(plugin, 'missing')).toThrow(/no MCP server named/);
  expect(() => resolveMcpStdioLaunch({}, plugin.basePath)).toThrow(/requires a stdio command/);
});

test('CLI main gate is a no-op when isMain is false', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runAiPluginsMain(false);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test('CLI main gate prints a live result when isMain is true', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runAiPluginsMain(true, async () => ({
      pluginName: 'di-framework',
      skillNames: ['di-framework-api'],
      ruleNames: ['AGENTS'],
      mcpServers: ['di-framework-mcp'],
      toolNames: ['di_scaffold_provider'],
      scaffoldPreview: '{"ok":true}',
    }));
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test('runLiveExample connects the official MCP and calls di_scaffold_provider', async () => {
  const result = await runLiveExample();
  expect(result.pluginName).toBe('di-framework');
  expect(result.mcpServers).toEqual(['di-framework-mcp']);
  expect(result.toolNames).toContain('di_scaffold_provider');
  expect(result.toolNames).toContain('di_search_docs');
  expect(result.toolNames).toContain('di_validate_tokens');
  expect(result.scaffoldPreview.length).toBeGreaterThan(20);
  expect(result.scaffoldPreview).toMatch(/GreetingService|interface|provider/i);
}, 60_000);
