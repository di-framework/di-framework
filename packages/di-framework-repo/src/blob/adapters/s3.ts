import type { BlobStorageAdapter } from '../adapter.js';
import type {
  BlobBody,
  BlobListOptions,
  BlobListResult,
  BlobMetadata,
  BlobObject,
  BlobPutOptions,
  BlobSignedUrlOptions,
} from '../types.js';
import { bodyToUint8Array, computeEtag, createBlobObject } from '../utils.js';

export interface S3ClientLike {
  getObject?(params: { Bucket: string; Key: string }): Promise<{
    Body?: unknown;
    ContentLength?: number;
    ContentType?: string;
    ETag?: string;
    LastModified?: Date | string;
    Metadata?: Record<string, string>;
  }>;
  putObject?(params: {
    Bucket: string;
    Key: string;
    Body: unknown;
    ContentType?: string;
    Metadata?: Record<string, string>;
  }): Promise<{ ETag?: string }>;
  deleteObject?(params: { Bucket: string; Key: string }): Promise<unknown>;
  deleteObjects?(params: {
    Bucket: string;
    Delete: { Objects: Array<{ Key: string }> };
  }): Promise<{ Deleted?: Array<{ Key?: string }> }>;
  headObject?(params: { Bucket: string; Key: string }): Promise<{
    ContentLength?: number;
    ContentType?: string;
    ETag?: string;
    LastModified?: Date | string;
    Metadata?: Record<string, string>;
  }>;
  listObjectsV2?(params: {
    Bucket: string;
    Prefix?: string;
    Delimiter?: string;
    ContinuationToken?: string;
    MaxKeys?: number;
  }): Promise<{
    Contents?: Array<{ Key?: string; Size?: number; ETag?: string; LastModified?: Date | string }>;
    CommonPrefixes?: Array<{ Prefix?: string }>;
    NextContinuationToken?: string;
    IsTruncated?: boolean;
  }>;
}

export interface S3BlobStorageOptions {
  /** S3 bucket name */
  bucket: string;
  /** AWS Region (default: 'us-east-1') */
  region?: string;
  /** Custom endpoint URL (e.g. 'https://s3.amazonaws.com', 'http://localhost:9000', or MinIO/R2 URL) */
  endpoint?: string;
  /** AWS Access Key ID */
  accessKeyId?: string;
  /** AWS Secret Access Key */
  secretAccessKey?: string;
  /** AWS Session Token (for temporary credentials) */
  sessionToken?: string;
  /** Force path style URLs (http://endpoint/bucket/key instead of http://bucket.endpoint/key). Default: true for localhost/ip/custom endpoints, false for standard S3 */
  forcePathStyle?: boolean;
  /** Size threshold in bytes above which multipart upload is used (default: 5MB) */
  multipartThreshold?: number;
  /** Part size in bytes for multipart uploads (default: 5MB) */
  partSize?: number;
  /** Custom fetch implementation (for mocking / testing / proxying) */
  fetch?: typeof fetch;
  /** Optional custom client instance or mock adapter */
  client?: S3ClientLike;
}

const DEFAULT_MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5 MB
const DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5 MB

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');
}

function toArrayBuffer(data: Uint8Array | string): ArrayBuffer {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

async function hmacSha256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const keyBuf = toArrayBuffer(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const dataBuf = toArrayBuffer(data);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBuf);
  return new Uint8Array(signature);
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const buf = toArrayBuffer(data);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getIsoTimestamps(date: Date = new Date()): { isoDate: string; dateStamp: string } {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const YYYY = date.getUTCFullYear();
  const MM = pad(date.getUTCMonth() + 1);
  const DD = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());

  const dateStamp = `${YYYY}${MM}${DD}`;
  const isoDate = `${dateStamp}T${hh}${mm}${ss}Z`;
  return { isoDate, dateStamp };
}

function extractTagValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  const val = match?.[1];
  return val !== undefined ? val.trim() : null;
}

function extractAllTags(xml: string, containerTag: string): string[] {
  const regex = new RegExp(`<${containerTag}[^>]*>([\\s\\S]*?)<\\/${containerTag}>`, 'gi');
  const matches: string[] = [];
  let match = regex.exec(xml);
  while (match !== null) {
    const matchedVal = match[1];
    if (matchedVal !== undefined) {
      matches.push(matchedVal);
    }
    match = regex.exec(xml);
  }
  return matches;
}

export class S3BlobStorageAdapter implements BlobStorageAdapter {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
  readonly forcePathStyle: boolean;
  readonly multipartThreshold: number;
  readonly partSize: number;
  private readonly customFetch: typeof fetch;
  readonly client?: S3ClientLike;

  constructor(options: S3BlobStorageOptions) {
    this.bucket = options.bucket;
    this.region = options.region ?? 'us-east-1';
    this.accessKeyId = options.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
    this.secretAccessKey = options.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
    this.sessionToken = options.sessionToken ?? process.env.AWS_SESSION_TOKEN;
    this.multipartThreshold = options.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD;
    this.partSize = options.partSize ?? DEFAULT_PART_SIZE;
    this.customFetch = options.fetch ?? fetch;
    this.client = options.client;

    let ep =
      options.endpoint ?? process.env.AWS_ENDPOINT_URL ?? `https://s3.${this.region}.amazonaws.com`;
    if (ep.endsWith('/')) {
      ep = ep.slice(0, -1);
    }
    this.endpoint = ep;

    if (options.forcePathStyle !== undefined) {
      this.forcePathStyle = options.forcePathStyle;
    } else {
      const parsed = new URL(this.endpoint);
      const isAwsHost =
        parsed.hostname === 'amazonaws.com' || parsed.hostname.endsWith('.amazonaws.com');
      const isCustomOrLocal =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || !isAwsHost;
      this.forcePathStyle = isCustomOrLocal;
    }
  }

  private buildUrl(
    key = '',
    queryParams: Record<string, string | undefined> = {},
  ): {
    url: URL;
    canonicalUri: string;
  } {
    const parsedEndpoint = new URL(this.endpoint);
    let canonicalUri: string;
    let finalHost = parsedEndpoint.host;

    const encodedKey = key ? encodeKeyPath(key) : '';

    if (this.forcePathStyle) {
      canonicalUri = key ? `/${this.bucket}/${encodedKey}` : `/${this.bucket}`;
    } else {
      finalHost = `${this.bucket}.${parsedEndpoint.host}`;
      canonicalUri = key ? `/${encodedKey}` : '/';
    }

    const url = new URL(`${parsedEndpoint.protocol}//${finalHost}${canonicalUri}`);
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined) {
        url.searchParams.set(k, v);
      }
    }

    return { url, canonicalUri };
  }

  private async signRequest(
    method: string,
    key = '',
    queryParams: Record<string, string | undefined> = {},
    headers: Record<string, string> = {},
    payload: Uint8Array | string = new Uint8Array(0),
    forcedDate?: Date,
  ): Promise<{ headers: Record<string, string>; url: URL }> {
    const { url, canonicalUri } = this.buildUrl(key, queryParams);
    const { isoDate, dateStamp } = getIsoTimestamps(forcedDate);

    const signedHeadersRecord: Record<string, string> = {
      host: url.host,
      'x-amz-date': isoDate,
      ...headers,
    };

    if (this.sessionToken) {
      signedHeadersRecord['x-amz-security-token'] = this.sessionToken;
    }

    if (!this.accessKeyId || !this.secretAccessKey) {
      return { headers: signedHeadersRecord, url };
    }

    const payloadHash = await sha256Hex(payload);
    signedHeadersRecord['x-amz-content-sha256'] = payloadHash;

    const headerKeys = Object.keys(signedHeadersRecord)
      .map((k) => k.toLowerCase())
      .sort();
    const canonicalHeaders = headerKeys
      .map((k) => `${k}:${(signedHeadersRecord[k] ?? '').trim()}\n`)
      .join('');
    const signedHeaders = headerKeys.join(';');

    const queryEntries: [string, string][] = [];
    url.searchParams.forEach((value, keyName) => {
      queryEntries.push([encodeRfc3986(keyName), encodeRfc3986(value)]);
    });
    queryEntries.sort((a, b) => a[0].localeCompare(b[0]));
    const canonicalQueryString = queryEntries.map(([k, v]) => `${k}=${v}`).join('&');

    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${isoDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

    const kDate = await hmacSha256(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = await hmacSha256(kDate, this.region);
    const kService = await hmacSha256(kRegion, 's3');
    const kSigning = await hmacSha256(kService, 'aws4_request');
    const signature = Array.from(await hmacSha256(kSigning, stringToSign))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    signedHeadersRecord.Authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { headers: signedHeadersRecord, url };
  }

  async get(key: string): Promise<BlobObject | null> {
    if (this.client?.getObject) {
      try {
        const res = await this.client.getObject({ Bucket: this.bucket, Key: key });
        if (!res || !res.Body) return null;
        const bytes = await bodyToUint8Array(res.Body as any);
        const metadata: BlobMetadata = {
          key,
          size: res.ContentLength ?? bytes.byteLength,
          etag: res.ETag,
          contentType: res.ContentType,
          lastModified: res.LastModified ? new Date(res.LastModified) : undefined,
          customMetadata: res.Metadata,
        };
        return createBlobObject(metadata, bytes);
      } catch (err: unknown) {
        const anyErr = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (anyErr.name === 'NoSuchKey' || anyErr.$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw err;
      }
    }

    const { headers, url } = await this.signRequest('GET', key);
    const response = await this.customFetch(url.toString(), {
      method: 'GET',
      headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`S3 GET request failed with status ${response.status}: ${errorText}`);
    }

    const metadata = this.parseResponseMetadata(key, response.headers);
    if (response.body) {
      return createBlobObject(metadata, response.body as ReadableStream<Uint8Array>);
    }
    const arrayBuf = await response.arrayBuffer();
    return createBlobObject(metadata, new Uint8Array(arrayBuf));
  }

  async put(key: string, body: BlobBody, options: BlobPutOptions = {}): Promise<BlobMetadata> {
    const data = await bodyToUint8Array(body);
    const size = options.contentLength ?? data.byteLength;

    if (size > this.multipartThreshold) {
      return this.putMultipart(key, data, options);
    }

    if (this.client?.putObject) {
      const res = await this.client.putObject({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: options.contentType,
        Metadata: options.customMetadata,
      });
      return {
        key,
        size,
        etag: res.ETag,
        contentType: options.contentType,
        lastModified: new Date(),
        customMetadata: options.customMetadata,
      };
    }

    const customHeaders: Record<string, string> = {
      'content-length': String(size),
      'content-type': options.contentType ?? 'application/octet-stream',
    };

    if (options.customMetadata) {
      for (const [mk, mv] of Object.entries(options.customMetadata)) {
        customHeaders[`x-amz-meta-${mk.toLowerCase()}`] = mv;
      }
    }

    const { headers, url } = await this.signRequest('PUT', key, {}, customHeaders, data);
    const response = await this.customFetch(url.toString(), {
      method: 'PUT',
      headers,
      body: data as BodyInit,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`S3 PUT request failed with status ${response.status}: ${errorText}`);
    }

    const etag = response.headers.get('etag') || (await computeEtag(data));
    return {
      key,
      size,
      etag,
      contentType: options.contentType ?? 'application/octet-stream',
      lastModified: new Date(),
      ...(options.customMetadata ? { customMetadata: { ...options.customMetadata } } : {}),
    };
  }

  private async putMultipart(
    key: string,
    data: Uint8Array,
    options: BlobPutOptions = {},
  ): Promise<BlobMetadata> {
    const uploadId = await this.initiateMultipartUpload(key, options);
    const completedParts: Array<{ partNumber: number; etag: string }> = [];

    try {
      const partCount = Math.ceil(data.byteLength / this.partSize);
      for (let i = 0; i < partCount; i++) {
        const partNumber = i + 1;
        const start = i * this.partSize;
        const end = Math.min(start + this.partSize, data.byteLength);
        const partData = data.subarray(start, end);

        const etag = await this.uploadPart(key, uploadId, partNumber, partData);
        completedParts.push({ partNumber, etag });
      }

      const finalEtag = await this.completeMultipartUpload(key, uploadId, completedParts);
      return {
        key,
        size: data.byteLength,
        etag: finalEtag,
        contentType: options.contentType ?? 'application/octet-stream',
        lastModified: new Date(),
        ...(options.customMetadata ? { customMetadata: { ...options.customMetadata } } : {}),
      };
    } catch (err) {
      await this.abortMultipartUpload(key, uploadId).catch(() => {});
      throw err;
    }
  }

  private async initiateMultipartUpload(
    key: string,
    options: BlobPutOptions = {},
  ): Promise<string> {
    const customHeaders: Record<string, string> = {
      'content-type': options.contentType ?? 'application/octet-stream',
    };
    if (options.customMetadata) {
      for (const [mk, mv] of Object.entries(options.customMetadata)) {
        customHeaders[`x-amz-meta-${mk.toLowerCase()}`] = mv;
      }
    }

    const { headers, url } = await this.signRequest('POST', key, { uploads: '' }, customHeaders);
    const response = await this.customFetch(url.toString(), {
      method: 'POST',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `S3 initiateMultipartUpload failed with status ${response.status}: ${errorText}`,
      );
    }

    const xml = await response.text();
    const uploadId = extractTagValue(xml, 'UploadId');
    if (!uploadId) {
      throw new Error(`Failed to parse UploadId from response XML: ${xml}`);
    }
    return uploadId;
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    partData: Uint8Array,
  ): Promise<string> {
    const customHeaders: Record<string, string> = {
      'content-length': String(partData.byteLength),
    };

    const { headers, url } = await this.signRequest(
      'PUT',
      key,
      { partNumber: String(partNumber), uploadId },
      customHeaders,
      partData,
    );

    const response = await this.customFetch(url.toString(), {
      method: 'PUT',
      headers,
      body: partData as BodyInit,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `S3 uploadPart #${partNumber} failed with status ${response.status}: ${errorText}`,
      );
    }

    const etag = response.headers.get('etag');
    if (!etag) {
      throw new Error(`S3 uploadPart #${partNumber} succeeded without ETag header`);
    }
    return etag;
  }

  private async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<string> {
    const partsXml = parts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join('');
    const completeXml = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;
    const payload = new TextEncoder().encode(completeXml);

    const { headers, url } = await this.signRequest(
      'POST',
      key,
      { uploadId },
      { 'content-type': 'application/xml', 'content-length': String(payload.byteLength) },
      payload,
    );

    const response = await this.customFetch(url.toString(), {
      method: 'POST',
      headers,
      body: payload,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `S3 completeMultipartUpload failed with status ${response.status}: ${errorText}`,
      );
    }

    const xml = await response.text();
    const etag = extractTagValue(xml, 'ETag') || response.headers.get('etag') || '';
    return etag;
  }

  private async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const { headers, url } = await this.signRequest('DELETE', key, { uploadId });
    await this.customFetch(url.toString(), {
      method: 'DELETE',
      headers,
    });
  }

  async delete(key: string): Promise<boolean> {
    if (this.client?.deleteObject) {
      await this.client.deleteObject({ Bucket: this.bucket, Key: key });
      return true;
    }

    const { headers, url } = await this.signRequest('DELETE', key);
    const response = await this.customFetch(url.toString(), {
      method: 'DELETE',
      headers,
    });

    return response.status === 204 || response.status === 200;
  }

  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    if (this.client?.deleteObjects) {
      const res = await this.client.deleteObjects({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      });
      return res.Deleted?.length ?? keys.length;
    }

    const objectsXml = keys.map((k) => `<Object><Key>${k}</Key></Object>`).join('');
    const deleteXml = `<Delete><Quiet>false</Quiet>${objectsXml}</Delete>`;
    const payload = new TextEncoder().encode(deleteXml);

    const { headers, url } = await this.signRequest(
      'POST',
      '',
      { delete: '' },
      { 'content-type': 'application/xml', 'content-length': String(payload.byteLength) },
      payload,
    );

    const response = await this.customFetch(url.toString(), {
      method: 'POST',
      headers,
      body: payload,
    });

    if (!response.ok) {
      let count = 0;
      for (const key of keys) {
        if (await this.delete(key)) count++;
      }
      return count;
    }

    const xml = await response.text();
    const deletedNodes = extractAllTags(xml, 'Deleted');
    return deletedNodes.length > 0 ? deletedNodes.length : keys.length;
  }

  async head(key: string): Promise<BlobMetadata | null> {
    if (this.client?.headObject) {
      try {
        const res = await this.client.headObject({ Bucket: this.bucket, Key: key });
        return {
          key,
          size: res.ContentLength ?? 0,
          etag: res.ETag,
          contentType: res.ContentType,
          lastModified: res.LastModified ? new Date(res.LastModified) : undefined,
          customMetadata: res.Metadata,
        };
      } catch (err: unknown) {
        const anyErr = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (anyErr.name === 'NotFound' || anyErr.$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw err;
      }
    }

    const { headers, url } = await this.signRequest('HEAD', key);
    const response = await this.customFetch(url.toString(), {
      method: 'HEAD',
      headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`S3 HEAD request failed with status ${response.status}`);
    }

    return this.parseResponseMetadata(key, response.headers);
  }

  async exists(key: string): Promise<boolean> {
    const meta = await this.head(key);
    return meta !== null;
  }

  async list(options: BlobListOptions = {}): Promise<BlobListResult> {
    const queryParams: Record<string, string | undefined> = {
      'list-type': '2',
      prefix: options.prefix,
      delimiter: options.delimiter,
      'continuation-token': options.cursor,
      'max-keys': options.limit !== undefined ? String(options.limit) : undefined,
    };

    if (this.client?.listObjectsV2) {
      const res = await this.client.listObjectsV2({
        Bucket: this.bucket,
        Prefix: options.prefix,
        Delimiter: options.delimiter,
        ContinuationToken: options.cursor,
        MaxKeys: options.limit,
      });

      const items: BlobMetadata[] = (res.Contents ?? []).map((c) => ({
        key: c.Key ?? '',
        size: c.Size ?? 0,
        etag: c.ETag,
        lastModified: c.LastModified ? new Date(c.LastModified) : undefined,
      }));

      const prefixes: string[] = (res.CommonPrefixes ?? [])
        .map((p) => p.Prefix)
        .filter((p): p is string => Boolean(p));
      return {
        items,
        prefixes,
        nextCursor: res.NextContinuationToken,
        hasMore: Boolean(res.IsTruncated),
      };
    }

    const { headers, url } = await this.signRequest('GET', '', queryParams);
    const response = await this.customFetch(url.toString(), {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`S3 ListObjectsV2 failed with status ${response.status}: ${errorText}`);
    }

    const xml = await response.text();
    const contentsNodes = extractAllTags(xml, 'Contents');
    const items: BlobMetadata[] = contentsNodes.map((node) => {
      const key = extractTagValue(node, 'Key') || '';
      const sizeStr = extractTagValue(node, 'Size');
      const etag = extractTagValue(node, 'ETag') || undefined;
      const lastModifiedStr = extractTagValue(node, 'LastModified');
      return {
        key,
        size: sizeStr ? Number(sizeStr) : 0,
        etag,
        lastModified: lastModifiedStr ? new Date(lastModifiedStr) : undefined,
      };
    });

    const prefixNodes = extractAllTags(xml, 'CommonPrefixes');
    const prefixes: string[] = prefixNodes
      .map((node) => extractTagValue(node, 'Prefix'))
      .filter((p): p is string => Boolean(p));

    const isTruncated = extractTagValue(xml, 'IsTruncated') === 'true';
    const nextCursor = extractTagValue(xml, 'NextContinuationToken') || undefined;

    return {
      items,
      prefixes,
      nextCursor,
      hasMore: isTruncated,
    };
  }

  async getSignedUrl(key: string, options: BlobSignedUrlOptions): Promise<string> {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error('Cannot generate S3 signed URL: missing accessKeyId or secretAccessKey');
    }

    const expiresIn = options.expiresInSeconds ?? 900;
    const method = options.operation.toUpperCase();
    const { isoDate, dateStamp } = getIsoTimestamps();
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;

    const { url, canonicalUri } = this.buildUrl(key);
    const queryParams: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': isoDate,
      'X-Amz-Expires': String(expiresIn),
      'X-Amz-SignedHeaders': 'host',
    };

    if (this.sessionToken) {
      queryParams['X-Amz-Security-Token'] = this.sessionToken;
    }

    const queryEntries: [string, string][] = Object.entries(queryParams).map(([k, v]) => [
      encodeRfc3986(k),
      encodeRfc3986(v),
    ]);
    queryEntries.sort((a, b) => a[0].localeCompare(b[0]));
    const canonicalQueryString = queryEntries.map(([k, v]) => `${k}=${v}`).join('&');

    const canonicalHeaders = `host:${url.host}\n`;
    const signedHeaders = 'host';
    const payloadHash = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const stringToSign = `AWS4-HMAC-SHA256\n${isoDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

    const kDate = await hmacSha256(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = await hmacSha256(kDate, this.region);
    const kService = await hmacSha256(kRegion, 's3');
    const kSigning = await hmacSha256(kService, 'aws4_request');
    const signature = Array.from(await hmacSha256(kSigning, stringToSign))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    url.search = `${canonicalQueryString}&X-Amz-Signature=${signature}`;
    return url.toString();
  }

  private parseResponseMetadata(key: string, headers: Headers): BlobMetadata {
    const contentLengthStr = headers.get('content-length');
    const contentType = headers.get('content-type') || 'application/octet-stream';
    const etag = headers.get('etag') || undefined;
    const lastModifiedStr = headers.get('last-modified');
    const lastModified = lastModifiedStr ? new Date(lastModifiedStr) : undefined;

    const customMetadata: Record<string, string> = {};
    headers.forEach((value, headerName) => {
      if (headerName.toLowerCase().startsWith('x-amz-meta-')) {
        const metaKey = headerName.slice(11);
        customMetadata[metaKey] = value;
      }
    });

    return {
      key,
      size: contentLengthStr ? Number(contentLengthStr) : 0,
      etag,
      contentType,
      lastModified,
      ...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
    };
  }

  dispose(): void {
    // S3 HTTP adapter does not hold open persistent sockets
  }
}
