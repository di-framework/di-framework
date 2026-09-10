import { describe, expect, it, mock } from 'bun:test';
import {
  BaseBlobRepository,
  type BlobBody,
  type BlobMetadata,
  type BlobObject,
  type BlobStorageAdapter,
  bodyToUint8Array,
  computeEtag,
  createBlobObject,
  InMemoryBlobStorageAdapter,
  S3BlobStorageAdapter,
  uint8ArrayToStream,
} from '../src/index.js';

class TestBlobRepository extends BaseBlobRepository {
  constructor(adapter: BlobStorageAdapter) {
    super(adapter);
  }
}

describe('Blob Storage Utilities', () => {
  it('converts various body formats to Uint8Array', async () => {
    // string
    const strData = await bodyToUint8Array('hello world');
    expect(new TextDecoder().decode(strData)).toBe('hello world');

    // Uint8Array
    const u8 = new Uint8Array([1, 2, 3]);
    expect(await bodyToUint8Array(u8)).toBe(u8);

    // ArrayBuffer
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([4, 5, 6, 7]);
    const fromBuf = await bodyToUint8Array(buf);
    expect(Array.from(fromBuf)).toEqual([4, 5, 6, 7]);

    // Blob
    const blob = new Blob(['blob content'], { type: 'text/plain' });
    const fromBlob = await bodyToUint8Array(blob);
    expect(new TextDecoder().decode(fromBlob)).toBe('blob content');

    // ReadableStream
    const stream = uint8ArrayToStream(new TextEncoder().encode('stream content'));
    const fromStream = await bodyToUint8Array(stream);
    expect(new TextDecoder().decode(fromStream)).toBe('stream content');

    // AsyncIterable
    async function* gen() {
      yield new Uint8Array([10, 20]);
      yield new Uint8Array([30, 40]);
    }
    const fromGen = await bodyToUint8Array(gen() as any);
    expect(Array.from(fromGen)).toEqual([10, 20, 30, 40]);

    // Fallback / unrecognized
    const fromFallback = await bodyToUint8Array(123 as any);
    expect(fromFallback.byteLength).toBe(0);
  });

  it('createBlobObject provides stream, arrayBuffer, text, and json methods', async () => {
    const meta: BlobMetadata = {
      key: 'test.json',
      size: 15,
      contentType: 'application/json',
    };

    // From Uint8Array
    const rawJson = '{"hello":"world"}';
    const blobObj = createBlobObject(meta, new TextEncoder().encode(rawJson));
    expect(blobObj.metadata.key).toBe('test.json');
    expect(await blobObj.text()).toBe(rawJson);
    expect(await blobObj.json<{ hello: string }>()).toEqual({ hello: 'world' });
    const ab = await blobObj.arrayBuffer();
    expect(ab.byteLength).toBe(rawJson.length);

    // From Stream
    const streamObj = createBlobObject(meta, uint8ArrayToStream(new TextEncoder().encode(rawJson)));
    const streamRead = streamObj.stream();
    const streamBytes = await bodyToUint8Array(streamRead);
    expect(new TextDecoder().decode(streamBytes)).toBe(rawJson);

    // Stream fallback
    const emptyObj = createBlobObject(meta, null as any);
    const emptyStreamBytes = await bodyToUint8Array(emptyObj.stream());
    expect(emptyStreamBytes.byteLength).toBe(0);
  });

  it('computes sha256 etag', async () => {
    const data = new TextEncoder().encode('test etag calculation');
    const etag = await computeEtag(data);
    expect(etag.startsWith('"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
    expect(etag.length).toBe(66);
  });
});

describe('InMemoryBlobStorageAdapter & BaseBlobRepository', () => {
  it('performs CRUD operations, pagination, and key normalization', async () => {
    const adapter = new InMemoryBlobStorageAdapter();
    const repo = new TestBlobRepository(adapter);

    expect(await repo.exists('/test/file.txt')).toBe(false);
    expect(await repo.get('/test/file.txt')).toBeNull();
    expect(await repo.head('/test/file.txt')).toBeNull();

    // Put object
    const putMeta = await repo.put('/test/file.txt', 'test content', {
      contentType: 'text/plain',
      customMetadata: { author: 'tester' },
    });
    expect(putMeta.key).toBe('test/file.txt');
    expect(putMeta.contentType).toBe('text/plain');
    expect(putMeta.customMetadata?.author).toBe('tester');

    // Exists and Head
    expect(await repo.exists('test/file.txt')).toBe(true);
    const headMeta = await repo.head('test/file.txt');
    expect(headMeta?.key).toBe('test/file.txt');
    expect(headMeta?.size).toBe(12);

    // Get
    const obj = await repo.get('/test/file.txt');
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe('test content');

    // Put more files for listing and pagination
    await repo.put('folder1/a.txt', 'a');
    await repo.put('folder1/b.txt', 'b');
    await repo.put('folder2/c.txt', 'c');
    await repo.put('root.txt', 'root');

    expect(adapter.size()).toBe(5);

    // List without options
    const listAll = await repo.list();
    expect(listAll.items.length).toBe(5);
    expect(listAll.prefixes).toEqual([]);
    expect(listAll.hasMore).toBe(false);

    // List with prefix and delimiter
    const listFolder1 = await repo.list({ prefix: 'folder1/', delimiter: '/' });
    expect(listFolder1.items.map((i) => i.key)).toEqual(['folder1/a.txt', 'folder1/b.txt']);
    expect(listFolder1.prefixes).toEqual([]);

    const listRootDelim = await repo.list({ delimiter: '/' });
    expect(listRootDelim.prefixes).toEqual(['folder1/', 'folder2/', 'test/']);
    expect(listRootDelim.items.map((i) => i.key)).toEqual(['root.txt']);

    // List with limit and cursor
    const listPaged = await repo.list({ limit: 2 });
    expect(listPaged.items.length).toBe(2);
    expect(listPaged.hasMore).toBe(true);
    expect(listPaged.nextCursor).toBe('folder1/b.txt');

    const listNextPage = await repo.list({ limit: 2, cursor: listPaged.nextCursor });
    expect(listNextPage.items.length).toBe(2);
    expect(listNextPage.items.map((i) => i.key)).toEqual(['folder2/c.txt', 'root.txt']);

    const listEndPage = await repo.list({ limit: 10, cursor: 'zzzz' });
    expect(listEndPage.items.length).toBe(0);
    expect(listEndPage.hasMore).toBe(false);

    // Signed URL
    const signedUrl = await repo.getSignedUrl('test/file.txt', {
      operation: 'get',
      expiresInSeconds: 300,
      contentType: 'text/plain',
    });
    expect(signedUrl).toContain('https://in-memory.local/test%2Ffile.txt');
    expect(signedUrl).toContain('operation=get');
    expect(signedUrl).toContain('contentType=text%2Fplain');

    // Delete
    expect(await repo.delete('test/file.txt')).toBe(true);
    expect(await repo.delete('non-existent')).toBe(false);

    // DeleteMany
    const deletedCount = await repo.deleteMany(['folder1/a.txt', 'folder1/b.txt', 'non-existent']);
    expect(deletedCount).toBe(2);

    // Dispose
    await repo.dispose();
    expect(adapter.size()).toBe(0);
  });

  it('BaseBlobRepository fallbacks when adapter lacks optional methods', async () => {
    const minimalAdapter: BlobStorageAdapter = {
      get: async () => null,
      put: async (k) => ({ key: k, size: 0 }),
      delete: async (k) => k === 'exist',
      head: async () => null,
      exists: async () => false,
      list: async () => ({ items: [], prefixes: [], hasMore: false }),
    };

    const repo = new TestBlobRepository(minimalAdapter);
    expect(await repo.deleteMany(['exist', 'not-exist'])).toBe(1);
    expect(repo.getSignedUrl('key', { operation: 'get' })).rejects.toThrow('getSignedUrl');
    await repo.dispose(); // should not throw
  });
});

describe('S3BlobStorageAdapter', () => {
  it('configures default and custom endpoint URLs correctly', () => {
    const awsAdapter = new S3BlobStorageAdapter({
      bucket: 'my-bucket',
      region: 'us-west-2',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(awsAdapter.bucket).toBe('my-bucket');
    expect(awsAdapter.region).toBe('us-west-2');
    expect(awsAdapter.forcePathStyle).toBe(false);

    const minioAdapter = new S3BlobStorageAdapter({
      bucket: 'my-bucket',
      endpoint: 'http://localhost:9000/',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
    });
    expect(minioAdapter.endpoint).toBe('http://localhost:9000');
    expect(minioAdapter.forcePathStyle).toBe(true);
  });

  it('performs CRUD and signed URL generation via fetch', async () => {
    const mockStorage = new Map<string, { body: Uint8Array; headers: Record<string, string> }>();

    const mockFetch = (async (input: any, init?: any) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url);
      const method = init?.method || 'GET';
      const path = decodeURIComponent(
        url.pathname.replace(/^\//, '').replace(/^test-bucket\/?/, ''),
      );

      if (method === 'HEAD') {
        const entry = mockStorage.get(path);
        if (!entry) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 200, headers: entry.headers });
      }

      if (method === 'GET') {
        if (url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') || '';
          const delimiter = url.searchParams.get('delimiter');
          let xml = '<ListBucketResult><IsTruncated>false</IsTruncated>';
          for (const [key, val] of mockStorage.entries()) {
            if (prefix && !key.startsWith(prefix)) continue;
            if (delimiter && key.includes(delimiter)) {
              const pref = key.slice(0, key.indexOf(delimiter) + 1);
              xml += `<CommonPrefixes><Prefix>${pref}</Prefix></CommonPrefixes>`;
              continue;
            }
            xml += `<Contents><Key>${key}</Key><Size>${val.body.byteLength}</Size><ETag>"mock-etag"</ETag><LastModified>2026-09-05T12:00:00.000Z</LastModified></Contents>`;
          }
          xml += '</ListBucketResult>';
          return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
        }

        const entry = mockStorage.get(path);
        if (!entry) {
          return new Response('Not Found', { status: 404 });
        }
        return new Response(entry.body as BodyInit, { status: 200, headers: entry.headers });
      }

      if (method === 'PUT') {
        const bodyBytes = init?.body ? await bodyToUint8Array(init.body as any) : new Uint8Array(0);
        const headers: Record<string, string> = {
          'content-length': String(bodyBytes.byteLength),
          'content-type':
            (init?.headers as Record<string, string>)?.['content-type'] ||
            'application/octet-stream',
          etag: '"mock-etag"',
          'last-modified': new Date().toUTCString(),
          'x-amz-meta-custom': 'val',
        };
        mockStorage.set(path, { body: bodyBytes, headers });
        return new Response(null, { status: 200, headers });
      }

      if (method === 'DELETE') {
        mockStorage.delete(path);
        return new Response(null, { status: 204 });
      }

      if (method === 'POST' && url.searchParams.has('delete')) {
        const xml = '<DeleteResult><Deleted><Key>file1.txt</Key></Deleted></DeleteResult>';
        return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
      }

      return new Response('Error', { status: 500 });
    }) as unknown as typeof fetch;

    const adapter = new S3BlobStorageAdapter({
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'TESTKEY',
      secretAccessKey: 'TESTSECRET',
      sessionToken: 'TESTTOKEN',
      forcePathStyle: true,
      endpoint: 'https://s3.amazonaws.com',
      fetch: mockFetch,
    });

    expect(await adapter.exists('file1.txt')).toBe(false);
    expect(await adapter.get('file1.txt')).toBeNull();

    // Put
    const putMeta = await adapter.put('file1.txt', 's3 content', {
      contentType: 'text/plain',
      customMetadata: { custom: 'val' },
    });
    expect(putMeta.key).toBe('file1.txt');
    expect(putMeta.size).toBe(10);
    expect(putMeta.customMetadata?.custom).toBe('val');

    // Exists & Head
    expect(await adapter.exists('file1.txt')).toBe(true);
    const headMeta = await adapter.head('file1.txt');
    expect(headMeta?.key).toBe('file1.txt');
    expect(headMeta?.contentType).toBe('text/plain');

    // Get
    const obj = await adapter.get('file1.txt');
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe('s3 content');

    // List
    const listRes = await adapter.list({ prefix: 'file' });
    expect(listRes.items.length).toBe(1);
    expect(listRes.items[0]?.key).toBe('file1.txt');

    // Signed URL
    const signedGet = await adapter.getSignedUrl('file1.txt', { operation: 'get' });
    expect(signedGet).toContain('X-Amz-Signature');
    expect(signedGet).toContain('X-Amz-Security-Token=TESTTOKEN');

    // Delete
    expect(await adapter.delete('file1.txt')).toBe(true);
    expect(await adapter.exists('file1.txt')).toBe(false);

    // DeleteMany
    const deletedCount = await adapter.deleteMany(['file1.txt']);
    expect(deletedCount).toBe(1);

    adapter.dispose();
  });

  it('handles multipart upload for large blobs', async () => {
    let initiated = false;
    let partsUploaded = 0;
    let completed = false;

    const mockFetch = (async (input: any, init?: any) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url);
      const method = init?.method || 'GET';

      if (method === 'POST' && url.searchParams.has('uploads')) {
        initiated = true;
        return new Response(
          '<InitiateMultipartUploadResult><UploadId>mock-upload-id</UploadId></InitiateMultipartUploadResult>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        );
      }

      if (method === 'PUT' && url.searchParams.has('uploadId')) {
        partsUploaded++;
        return new Response(null, {
          status: 200,
          headers: { etag: `"part-${url.searchParams.get('partNumber')}"` },
        });
      }

      if (method === 'POST' && url.searchParams.has('uploadId')) {
        completed = true;
        return new Response(
          '<CompleteMultipartUploadResult><ETag>"final-multipart-etag"</ETag></CompleteMultipartUploadResult>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        );
      }

      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new S3BlobStorageAdapter({
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'TESTKEY',
      secretAccessKey: 'TESTSECRET',
      multipartThreshold: 10,
      partSize: 5,
      fetch: mockFetch,
    });

    const largeData = new Uint8Array(12); // 12 bytes > 10 threshold -> 3 parts (5 + 5 + 2)
    const meta = await adapter.put('large.bin', largeData);

    expect(initiated).toBe(true);
    expect(partsUploaded).toBe(3);
    expect(completed).toBe(true);
    expect(meta.etag).toBe('"final-multipart-etag"');
    expect(meta.size).toBe(12);
  });

  it('handles custom client instance delegation', async () => {
    const mockClient = {
      getObject: mock(async () => ({
        Body: new TextEncoder().encode('delegated content'),
        ContentLength: 17,
        ContentType: 'text/plain',
        ETag: '"etag-123"',
        LastModified: new Date(),
        Metadata: { key: 'val' },
      })),
      putObject: mock(async () => ({ ETag: '"put-etag"' })),
      deleteObject: mock(async () => ({})),
      deleteObjects: mock(async () => ({ Deleted: [{ Key: 'k1' }, { Key: 'k2' }] })),
      headObject: mock(async () => ({
        ContentLength: 17,
        ContentType: 'text/plain',
        ETag: '"etag-123"',
        LastModified: new Date(),
        Metadata: { key: 'val' },
      })),
      listObjectsV2: mock(async () => ({
        Contents: [{ Key: 'k1', Size: 10, ETag: '"e1"', LastModified: new Date() }],
        CommonPrefixes: [{ Prefix: 'dir/' }],
        NextContinuationToken: 'token-next',
        IsTruncated: true,
      })),
    };

    const adapter = new S3BlobStorageAdapter({
      bucket: 'custom-bucket',
      client: mockClient,
    });

    const obj = await adapter.get('test.txt');
    expect(await obj!.text()).toBe('delegated content');

    const putMeta = await adapter.put('test.txt', 'body');
    expect(putMeta.etag).toBe('"put-etag"');

    const headMeta = await adapter.head('test.txt');
    expect(headMeta?.size).toBe(17);

    const listRes = await adapter.list();
    expect(listRes.items.length).toBe(1);
    expect(listRes.prefixes).toEqual(['dir/']);
    expect(listRes.hasMore).toBe(true);

    expect(await adapter.delete('test.txt')).toBe(true);
    expect(await adapter.deleteMany(['k1', 'k2'])).toBe(2);
  });

  it('handles client not-found errors gracefully', async () => {
    const mockClient = {
      getObject: mock(async () => {
        const err: any = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      }),
      headObject: mock(async () => {
        const err: any = new Error('NotFound');
        err.name = 'NotFound';
        throw err;
      }),
    };

    const adapter = new S3BlobStorageAdapter({
      bucket: 'custom-bucket',
      client: mockClient,
    });

    expect(await adapter.get('missing.txt')).toBeNull();
    expect(await adapter.head('missing.txt')).toBeNull();
    expect(await adapter.exists('missing.txt')).toBe(false);
  });

  it('handles error states and missing credentials in signed URLs', async () => {
    const unauthenticatedAdapter = new S3BlobStorageAdapter({
      bucket: 'public-bucket',
    });

    expect(unauthenticatedAdapter.getSignedUrl('file.txt', { operation: 'get' })).rejects.toThrow(
      'missing accessKeyId',
    );

    const failingFetch = (async () =>
      new Response('Internal error', { status: 500 })) as unknown as typeof fetch;
    const errorAdapter = new S3BlobStorageAdapter({
      bucket: 'error-bucket',
      accessKeyId: 'KEY',
      secretAccessKey: 'SECRET',
      fetch: failingFetch,
    });

    expect(errorAdapter.get('file.txt')).rejects.toThrow('status 500');
    expect(errorAdapter.put('file.txt', 'content')).rejects.toThrow('status 500');
    expect(errorAdapter.head('file.txt')).rejects.toThrow('status 500');
    expect(errorAdapter.list()).rejects.toThrow('status 500');
  });

  it('handles multipart upload failure and triggers abort', async () => {
    let aborted = false;
    const mockFetch = (async (input: any, init?: any) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url);
      const method = init?.method || 'GET';

      if (method === 'POST' && url.searchParams.has('uploads')) {
        return new Response(
          '<InitiateMultipartUploadResult><UploadId>abort-upload-id</UploadId></InitiateMultipartUploadResult>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        );
      }

      if (method === 'PUT' && url.searchParams.has('uploadId')) {
        return new Response('Part upload failed', { status: 500 });
      }

      if (method === 'DELETE' && url.searchParams.has('uploadId')) {
        aborted = true;
        return new Response(null, { status: 204 });
      }

      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new S3BlobStorageAdapter({
      bucket: 'test-bucket',
      multipartThreshold: 10,
      partSize: 5,
      fetch: mockFetch,
    });

    expect(adapter.put('fail.bin', new Uint8Array(20))).rejects.toThrow('uploadPart #1 failed');
    // Allow abort microtask to complete
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });

  it('handles deleteMany fallback when batch delete endpoint fails', async () => {
    let singleDeletes = 0;
    const mockFetch = (async (input: any, init?: any) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url);
      const method = init?.method || 'GET';

      if (method === 'POST' && url.searchParams.has('delete')) {
        return new Response('Batch delete not allowed', { status: 403 });
      }

      if (method === 'DELETE') {
        singleDeletes++;
        return new Response(null, { status: 204 });
      }

      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new S3BlobStorageAdapter({
      bucket: 'test-bucket',
      fetch: mockFetch,
    });

    const deleted = await adapter.deleteMany(['k1', 'k2']);
    expect(deleted).toBe(2);
    expect(singleDeletes).toBe(2);
  });

  it('handles cached BlobObject methods and empty deleteMany', async () => {
    const meta: BlobMetadata = { key: 'sample.txt', size: 6 };
    const bytes = new TextEncoder().encode('sample');
    const obj = createBlobObject(meta, bytes);

    expect(await obj.text()).toBe('sample');
    const stream = obj.stream();
    const readBytes = await bodyToUint8Array(stream);
    expect(new TextDecoder().decode(readBytes)).toBe('sample');

    const adapter = new S3BlobStorageAdapter({ bucket: 'test-bucket' });
    expect(await adapter.deleteMany([])).toBe(0);
  });
});
