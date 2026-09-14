import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { CliIo } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from './deps';
import type { WasmcloudProject } from './project';
import { registryReferenceHost, registryUsesPlainHttp } from './registry';
import { toolFailed } from './support';
import type { ClusterConnection } from './target';

export type PublishedImage = {
  artifactDigest: string;
  digest: string;
  pullReference: string;
  pushReference: string;
  reference: string;
};

export function contentDigest(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function ociReference(registry: string, repository: string, digest: string): string {
  return `${registryReferenceHost(registry)}/${repository}:sha256-${digest}`;
}

export async function publishComponent(
  project: WasmcloudProject,
  connection: ClusterConnection,
  io: CliIo,
  deps: WasmcloudDeps,
  deploymentDigest: string,
): Promise<PublishedImage> {
  const artifactDigest = contentDigest(project.outputPath);
  const pushReference = ociReference(connection.registry.push, project.witName, deploymentDigest);

  const configPath = join(project.projectRoot, '.di-framework', 'oci-config.json');
  const componentPath = projectRelativePath(project.projectRoot, project.outputPath);
  const projectConfigPath = projectRelativePath(project.projectRoot, configPath);
  io.stdout.write(`Publishing ${componentPath} as ${pushReference}...\n`);
  const transportArgs = registryUsesPlainHttp(connection.registry) ? ['--plain-http'] : [];
  let descriptor = await deps.runCaptured(
    'oras',
    ['manifest', 'fetch', ...transportArgs, '--descriptor', pushReference],
    { cwd: project.projectRoot },
  );
  if (descriptor.exitCode === 0) {
    io.stdout.write(`OCI tag ${pushReference} already exists; keeping it immutable.\n`);
  } else {
    const pushed = await deps.runner(
      'oras',
      [
        'push',
        ...transportArgs,
        '--config',
        `${projectConfigPath}:application/vnd.wasm.config.v0+json`,
        pushReference,
        `${componentPath}:application/wasm`,
      ],
      { cwd: project.projectRoot },
    );
    if (pushed.exitCode !== 0) {
      throw toolFailed('oras push', pushed.exitCode);
    }
    descriptor = await deps.runCaptured(
      'oras',
      ['manifest', 'fetch', ...transportArgs, '--descriptor', pushReference],
      { cwd: project.projectRoot },
    );
  }
  if (descriptor.exitCode !== 0) throw toolFailed('oras manifest fetch', descriptor.exitCode);
  const { digest: manifestDigest } = JSON.parse(descriptor.stdout) as { digest?: string };
  if (typeof manifestDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifestDigest)) {
    throw new Error('OCI manifest descriptor must contain a sha256 digest');
  }
  const pullReference = `${registryReferenceHost(connection.registry.pull)}/${project.witName}@${manifestDigest}`;
  return {
    artifactDigest,
    digest: deploymentDigest,
    pullReference,
    pushReference,
    reference: pushReference,
  };
}

export function projectRelativePath(projectRoot: string, path: string): string {
  const value = relative(projectRoot, path);
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`OCI artifact path must be inside the project: ${path}`);
  }
  return value.split(sep).join('/');
}
