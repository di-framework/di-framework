import { createHash } from 'node:crypto';
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
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export interface StaticAssetOptions {
  /** The filesystem directory to serve assets from. */
  directory: string;
  /**
   * When true, passes unhandled requests to subsequent router routes instead of
   * responding with 404/405. Defaults to false.
   */
  fallthrough?: boolean;
  /** Value for the Cache-Control response header. */
  cacheControl?: string;
  /** Pre-generated asset manifest or path to manifest JSON file. */
  manifest?: StaticAssetManifest | string;
  /** Pre-packaged assets bundle containing in-memory file contents. */
  package?: StaticAssetPackage;
  /**
   * Whether to read files live from disk. If not specified, defaults to true
   * if directory exists on disk and no package is provided.
   */
  live?: boolean;
}

export interface StaticMountOptions extends StaticAssetOptions {
  prefix?: string;
}

export interface StaticAssetManifestEntry {
  path: string;
  contentType: string;
  size: number;
  hash: string;
  etag: string;
}

export interface StaticAssetManifest {
  version: 1;
  generatedAt: string;
  directory?: string;
  assets: Record<string, StaticAssetManifestEntry>;
}

export interface StaticAssetPackageEntry extends StaticAssetManifestEntry {
  content: string;
  encoding: 'utf-8' | 'base64';
}

export interface StaticAssetPackage {
  version: 1;
  generatedAt: string;
  directory?: string;
  assets: Record<string, StaticAssetPackageEntry>;
}

export interface PackageStaticAssetsOptions {
  directory: string;
  outputDir?: string;
  outFile?: string;
  format?: 'json' | 'js' | 'ts';
  prefix?: string;
}

export const MIME_TYPES: Record<string, string> = {
  // Web & text
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonld': 'application/ld+json',
  '.txt': 'text/plain; charset=utf-8',
  '.text': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',

  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',

  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',

  // Audio & Video
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.webm': 'video/webm',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',

  // Documents & binary
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
};

export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType.includes('charset=utf-8') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'image/svg+xml'
  );
}

export function computeContentHash(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function computeETag(hash: string): string {
  return `"${hash.slice(0, 32)}"`;
}

export function matchesIfNoneMatch(ifNoneMatch: string, etag: string): boolean {
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;

  const normalizeTag = (tag: string) => tag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

  const targetTag = normalizeTag(etag);
  const candidateTags = trimmed.split(',').map(normalizeTag);
  return candidateTags.includes(targetTag);
}

export function normalizeRoutePrefix(prefix: string): string {
  if (!prefix || prefix === '/') return '';
  const withLeading = prefix.startsWith('/') ? prefix : `/${prefix}`;
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

const packageRegistry = new Map<string, StaticAssetPackage | StaticAssetManifest>();

export function registerStaticAssets(
  key: string,
  pkgOrManifest: StaticAssetPackage | StaticAssetManifest,
): void {
  const normalizedKey = normalizeRoutePrefix(key) || key;
  packageRegistry.set(normalizedKey, pkgOrManifest);
}

export function getRegisteredStaticAssets(
  key: string,
): StaticAssetPackage | StaticAssetManifest | undefined {
  const normalizedKey = normalizeRoutePrefix(key) || key;
  return packageRegistry.get(normalizedKey) ?? packageRegistry.get(key);
}

export function clearRegisteredStaticAssets(): void {
  packageRegistry.clear();
}

export function createFileStream(
  filePath: string | number,
  chunkSize = 64 * 1024,
): ReadableStream<Uint8Array> {
  const fd = typeof filePath === 'number' ? filePath : openSync(filePath, 'r');
  return Readable.toWeb(
    createReadStream('', { fd, autoClose: true, highWaterMark: chunkSize }),
  ) as unknown as ReadableStream<Uint8Array>;
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

export function createBufferStream(
  data: Uint8Array,
  chunkSize = 64 * 1024,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const nextOffset = Math.min(offset + chunkSize, data.length);
      const chunk = data.subarray(offset, nextOffset);
      offset = nextOffset;
      controller.enqueue(chunk);
    },
  });
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

/**
 * Creates an HTTP route handler for static asset serving according to the
 * specified prefix and options.
 */
export function createStaticAssetHandler(
  prefix: string,
  options: StaticAssetOptions,
): (request: Request, ...args: unknown[]) => Promise<Response | undefined> {
  const cleanPrefix = normalizeRoutePrefix(prefix);
  const fallthrough = options.fallthrough ?? false;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Check if pathname matches prefix
    let relativeUrlPath: string;
    if (cleanPrefix === '') {
      relativeUrlPath = pathname;
    } else if (pathname === cleanPrefix) {
      relativeUrlPath = '/';
    } else if (pathname.startsWith(cleanPrefix + '/')) {
      relativeUrlPath = pathname.slice(cleanPrefix.length);
    } else {
      return undefined;
    }

    // Method check: only GET and HEAD supported for static asset serving
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      if (fallthrough) return undefined;
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      });
    }

    // URL decode pathname
    let decoded: string;
    try {
      decoded = decodeURIComponent(relativeUrlPath);
    } catch {
      if (fallthrough) return undefined;
      return new Response('Bad Request', { status: 400 });
    }

    // Security check: null bytes
    if (decoded.includes('\0')) {
      if (fallthrough) return undefined;
      return new Response('Forbidden', { status: 403 });
    }

    // Security check: double-encoded traversal
    if (decoded.includes('%')) {
      try {
        const secondDecoded = decodeURIComponent(decoded);
        if (secondDecoded.split(/[/\\]/).some((p) => p === '..')) {
          if (fallthrough) return undefined;
          return new Response('Forbidden', { status: 403 });
        }
      } catch {
        // ignore
      }
    }

    // Security check: check raw segments before normalization
    const rawSegments = decoded.split(/[/\\]/).filter(Boolean);
    for (const segment of rawSegments) {
      if (segment === '..') {
        if (fallthrough) return undefined;
        return new Response('Forbidden', { status: 403 });
      }
      if (segment.startsWith('.')) {
        if (fallthrough) return undefined;
        return new Response('Not Found', { status: 404 });
      }
    }

    // Normalize posix path
    const normalizedPath = posix.normalize('/' + decoded);

    // Root or empty path is a directory (directory listings disabled by default)
    if (normalizedPath === '/' || normalizedPath === '') {
      if (fallthrough) return undefined;
      return new Response('Not Found', { status: 404 });
    }

    const segments = normalizedPath.split('/').filter(Boolean);

    // Resolve pre-packaged assets if available
    let assetPackage: StaticAssetPackage | undefined = options.package;
    if (!assetPackage && options.manifest) {
      if (typeof options.manifest === 'object') {
        assetPackage = options.manifest as unknown as StaticAssetPackage;
      } else if (typeof options.manifest === 'string' && existsSync(options.manifest)) {
        try {
          assetPackage = JSON.parse(readFileSync(options.manifest, 'utf-8'));
        } catch {
          // ignore parse error
        }
      }
    }

    if (!assetPackage) {
      const registered =
        getRegisteredStaticAssets(prefix) ??
        getRegisteredStaticAssets(cleanPrefix) ??
        getRegisteredStaticAssets(options.directory);
      if (registered) {
        assetPackage = registered as StaticAssetPackage;
      }
    }

    const dirExists = existsSync(options.directory);
    const hasPackagedContents =
      assetPackage &&
      Object.values(assetPackage.assets ?? {}).some((entry) => entry.content !== undefined);
    const useLive = options.live ?? (dirExists && !hasPackagedContents);

    // Local dev: read live from disk
    if (useLive && dirExists) {
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
      headers.set('Content-Length', String(size));
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

    // Packaged assets fallback (e.g. wasmCloud or server without source dir)
    if (assetPackage && assetPackage.assets) {
      const posixKey = normalizedPath;
      const altKey = normalizedPath.startsWith('/')
        ? normalizedPath.slice(1)
        : `/${normalizedPath}`;
      const entry = assetPackage.assets[posixKey] ?? assetPackage.assets[altKey];

      if (!entry || entry.content === undefined) {
        if (fallthrough) return undefined;
        return new Response('Not Found', { status: 404 });
      }

      const contentType = entry.contentType || getMimeType(entry.path);
      const size = entry.size;
      const hash = entry.hash;
      const etag = entry.etag || computeETag(hash);

      // ETag conditional check
      const ifNoneMatch = request.headers.get('if-none-match');
      if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, etag)) {
        const headers = new Headers();
        headers.set('ETag', etag);
        if (options.cacheControl) {
          headers.set('Cache-Control', options.cacheControl);
        }
        return new Response(null, {
          status: 304,
          headers,
        });
      }

      const headers = new Headers();
      headers.set('Content-Type', contentType);
      headers.set('Content-Length', String(size));
      headers.set('ETag', etag);
      if (options.cacheControl) {
        headers.set('Cache-Control', options.cacheControl);
      }

      if (method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }

      const data =
        entry.encoding === 'base64'
          ? Buffer.from(entry.content, 'base64')
          : Buffer.from(entry.content, 'utf-8');

      const stream = createBufferStream(data);
      return new Response(stream, { status: 200, headers });
    }

    // Neither live directory nor packaged asset available
    if (fallthrough) return undefined;
    return new Response('Not Found', { status: 404 });
  };
}
