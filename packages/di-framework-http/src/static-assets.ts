import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import {
  computeContentHash,
  computeETag,
  getMimeType,
  installNativeStaticAssets,
  isTextMimeType,
  matchesIfNoneMatch,
  type PackageStaticAssetsOptions,
  type StaticAssetManifest,
  type StaticAssetManifestEntry,
  type StaticAssetOptions,
  type StaticAssetPackage,
  type StaticAssetPackageEntry,
} from './static-assets-runtime.ts';

export * from './static-assets-runtime.ts';

/**
 * Transfers ownership of an open descriptor to a stream. Consumers must read the
 * body or cancel it when discarding a response so the descriptor can be closed.
 */
export function createFileStream(
  filePath: string | number,
  chunkSize = 64 * 1024,
): ReadableStream<Uint8Array> {
  const fd = typeof filePath === 'number' ? filePath : openSync(filePath, 'r');
  let source: ReturnType<typeof createReadStream>;
  try {
    source = createReadStream('', { fd, autoClose: true, highWaterMark: chunkSize });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  try {
    return Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
  } catch (error) {
    source.destroy();
    throw error;
  }
}

function openAssetFile(root: string, filePath: string): { fd: number; stat: Stats } {
  const canonical = realpathSync(filePath);
  if (!canonical.startsWith(root + sep)) throw new Error('Asset escapes its root directory');
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const checkedPath = realpathSync(filePath);
    if (!checkedPath.startsWith(root + sep)) throw new Error('Asset escapes its root directory');
    const checkedStat = statSync(checkedPath);
    if (!stat.isFile() || stat.ino !== checkedStat.ino || stat.dev !== checkedStat.dev) {
      throw new Error('Asset changed while opening or is not a regular file');
    }
    return { fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Generates an asset manifest (index) mapping asset paths to MIME types, sizes,
 * content hashes, and ETags.
 */
export function generateAssetManifest(directory: string): StaticAssetManifest {
  const rootDir = resolve(directory);
  if (!existsSync(rootDir)) {
    throw new Error(`Directory not found: ${rootDir}`);
  }

  const realRootDir = realpathSync(rootDir);
  const assets: Record<string, StaticAssetManifestEntry> = {};

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // ignore hidden files/directories
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const realEntryPath = realpathSync(fullPath);
          // Ensure symlink doesn't escape rootDir
          if (!realEntryPath.startsWith(realRootDir + sep) && realEntryPath !== realRootDir) {
            continue;
          }
          const { fd, stat } = openAssetFile(realRootDir, fullPath);

          const relPath = posix.normalize(
            '/' + relative(realRootDir, fullPath).split(sep).join('/'),
          );
          let buffer: Buffer;
          try {
            buffer = readFileSync(fd);
          } finally {
            closeSync(fd);
          }
          const hash = computeContentHash(buffer);
          const etag = computeETag(hash);
          const contentType = getMimeType(fullPath);

          assets[relPath] = {
            path: relPath,
            contentType,
            size: stat.size,
            hash,
            etag,
          };
        } catch {
          // ignore unreadable files
        }
      }
    }
  }

  walk(realRootDir);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    directory: rootDir,
    assets,
  };
}

/**
 * Packages assets from directory into an in-memory package format with encoded
 * file content, and optionally writes out bundle or manifest files.
 */
export function packageStaticAssets(options: PackageStaticAssetsOptions): StaticAssetPackage {
  const manifest = generateAssetManifest(options.directory);
  const rootDir = resolve(options.directory);
  const realRootDir = realpathSync(rootDir);
  const packageAssets: Record<string, StaticAssetPackageEntry> = {};

  for (const [relPath, entry] of Object.entries(manifest.assets)) {
    const filePath = join(realRootDir, relPath.replace(/^\//, '').split('/').join(sep));
    const { fd } = openAssetFile(realRootDir, filePath);
    let buffer: Buffer;
    try {
      buffer = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    const isText = isTextMimeType(entry.contentType);

    const content = isText ? buffer.toString('utf-8') : buffer.toString('base64');
    const encoding: 'utf-8' | 'base64' = isText ? 'utf-8' : 'base64';

    packageAssets[relPath] = {
      ...entry,
      content,
      encoding,
    };
  }

  const pkg: StaticAssetPackage = {
    version: 1,
    generatedAt: manifest.generatedAt,
    directory: options.directory,
    assets: packageAssets,
  };

  if (options.outputDir) {
    mkdirSync(options.outputDir, { recursive: true });
    writeFileSync(
      join(options.outputDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(options.outputDir, 'static-assets.json'),
      JSON.stringify(pkg, null, 2),
      'utf-8',
    );
  }

  if (options.outFile) {
    mkdirSync(dirname(options.outFile), { recursive: true });
    if (options.outFile.endsWith('.json') || options.format === 'json') {
      writeFileSync(options.outFile, JSON.stringify(pkg, null, 2), 'utf-8');
    } else {
      // JavaScript or TypeScript module
      const mountKey = options.prefix ?? options.directory;
      const code = `import { registerStaticAssets } from '@di-framework/http';\n\nexport const staticAssetPackage = ${JSON.stringify(pkg, null, 2)};\n\nregisterStaticAssets(${JSON.stringify(mountKey)}, staticAssetPackage);\n\nexport default staticAssetPackage;\n`;
      writeFileSync(options.outFile, code, 'utf-8');
    }
  }

  return pkg;
}

function serveNativeAsset(
  request: Request,
  options: StaticAssetOptions,
  segments: string[],
): Response | undefined {
  const fallthrough = options.fallthrough ?? false;
  const method = request.method.toUpperCase();
  let realRootDir: string;
  try {
    realRootDir = realpathSync(options.directory);
  } catch {
    if (fallthrough) return undefined;
    return new Response('Not Found', { status: 404 });
  }

  const targetPath = resolve(realRootDir, ...segments);

  if (!existsSync(targetPath)) {
    if (fallthrough) return undefined;
    return new Response('Not Found', { status: 404 });
  }

  // Symlink escape check
  let realTargetPath: string;
  try {
    realTargetPath = realpathSync(targetPath);
  } catch {
    if (fallthrough) return undefined;
    return new Response('Not Found', { status: 404 });
  }

  if (!realTargetPath.startsWith(realRootDir + sep) && realTargetPath !== realRootDir) {
    if (fallthrough) return undefined;
    return new Response('Forbidden', { status: 403 });
  }

  let opened: ReturnType<typeof openAssetFile>;
  try {
    opened = openAssetFile(realRootDir, targetPath);
  } catch {
    if (fallthrough) return undefined;
    return new Response('Not Found', { status: 404 });
  }
  const { fd, stat } = opened;
  const contentType = getMimeType(realTargetPath);
  const size = stat.size;
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}-${stat.ctimeMs.toString(16)}"`;

  // ETag conditional check
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, etag)) {
    const headers = new Headers();
    headers.set('ETag', etag);
    if (options.cacheControl) {
      headers.set('Cache-Control', options.cacheControl);
    }
    closeSync(fd);
    return new Response(null, {
      status: 304,
      headers,
    });
  }

  const headers = new Headers();
  headers.set('Content-Type', contentType);
  // Live files can change while streaming; only HEAD reports a size snapshot.
  if (method === 'HEAD') headers.set('Content-Length', String(size));
  headers.set('ETag', etag);
  if (options.cacheControl) {
    headers.set('Cache-Control', options.cacheControl);
  }

  if (method === 'HEAD') {
    closeSync(fd);
    return new Response(null, { status: 200, headers });
  }

  const stream = createFileStream(fd);
  return new Response(stream, { status: 200, headers });
}

installNativeStaticAssets({
  exists: existsSync,
  readManifest: (path) => JSON.parse(readFileSync(path, 'utf-8')),
  serve: serveNativeAsset,
});
