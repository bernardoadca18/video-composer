import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { ComposerError } from '../core/errors.js';
import { sha256File } from '../core/identity.js';
import type { CacheCatalog, CacheKind } from './cache-catalog.js';

export interface CachedFile {
  path: string;
  cacheHit: boolean;
  byteSize: number;
  sha256: string;
}

export interface MaterializationContext {
  sourceKind: 'narration' | 'gameplay' | 'static_image' | 'music';
  mediaId?: string;
  assetId?: string;
}

export interface MaterializationOptions {
  idleTimeoutMs: number;
  maximumBytes: number;
  context: MaterializationContext;
  catalog?: CacheCatalog;
  cacheKind?: CacheKind;
  profileIdentity?: string;
}

class AssetTransferIdleTimeoutError extends Error {
  override readonly name = 'AssetTransferIdleTimeoutError';
}

const pause = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

export const withFileLock = async <T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30 * 60 * 1000) await unlink(lockPath);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError;
      }
      if (Date.now() - started > 60_000) {
        throw new ComposerError('cache_lock_timeout', 'Asset cache lock timed out');
      }
      await pause(50);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
};

const validCachedFile = async (
  target: string,
  expectedSha256: string,
  expectedSize: number | null,
  catalog?: CacheCatalog,
  cacheKind: CacheKind = 'source',
  profileIdentity?: string,
): Promise<CachedFile | null> => {
  try {
    const details = await stat(target);
    if (!details.isFile() || (expectedSize !== null && details.size !== expectedSize)) return null;
    if (catalog?.isHotValid(target, expectedSha256, expectedSize)) {
      return { path: target, cacheHit: true, byteSize: details.size, sha256: expectedSha256 };
    }
    const actual = await sha256File(target);
    if (actual !== expectedSha256) return null;
    catalog?.record({
      cacheKey: target,
      cacheKind,
      sha256: actual,
      byteSize: details.size,
      ...(profileIdentity ? { profileIdentity } : {}),
    });
    return { path: target, cacheHit: true, byteSize: details.size, sha256: actual };
  } catch {
    return null;
  }
};

export const materializeResponse = async (
  target: string,
  expectedSha256: string,
  expectedSize: number | null,
  responseFactory: (transferSignal: AbortSignal) => Promise<Response>,
  options: MaterializationOptions,
): Promise<CachedFile> => {
  const lockPath = `${target}.lock`;
  return await withFileLock(lockPath, async () => {
    const cached = await validCachedFile(
      target,
      expectedSha256,
      expectedSize,
      options.catalog,
      options.cacheKind,
      options.profileIdentity,
    );
    if (cached) return cached;
    await mkdir(path.dirname(target), { recursive: true });
    await unlink(target).catch(() => undefined);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const started = performance.now();
    const transferController = new AbortController();
    let idleTimeout: NodeJS.Timeout | undefined;
    let idleTimeoutError: AssetTransferIdleTimeoutError | undefined;
    let byteSize = 0;
    const diagnostics = () => ({
      source_kind: options.context.sourceKind,
      media_id: options.context.mediaId,
      asset_id: options.context.assetId,
      expected_size_bytes: expectedSize,
      maximum_size_bytes: options.maximumBytes,
      bytes_written: byteSize,
      elapsed_ms: Math.round(performance.now() - started),
      retryable: true,
    });
    const armIdleTimeout = (): void => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        idleTimeoutError = new AssetTransferIdleTimeoutError(
          `Asset transfer made no progress for ${options.idleTimeoutMs} ms`,
        );
        transferController.abort(idleTimeoutError);
      }, options.idleTimeoutMs);
    };
    try {
      armIdleTimeout();
      const response = await responseFactory(transferController.signal);
      if (!response.body) throw new ComposerError('dependency_contract', 'Empty asset response');
      const contentLength = response.headers.get('content-length');
      if (
        expectedSize !== null &&
        contentLength !== null &&
        Number.parseInt(contentLength, 10) !== expectedSize
      ) {
        throw new ComposerError(
          'asset_identity_mismatch',
          'Downloaded asset identity mismatch',
          500,
          { diagnostics: diagnostics() },
        );
      }
      const digest = createHash('sha256');
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          digest.update(chunk);
          byteSize += chunk.length;
          if (byteSize > options.maximumBytes) {
            callback(
              new ComposerError(
                'asset_identity_mismatch',
                'Downloaded asset exceeds maximum size',
                500,
                { diagnostics: diagnostics() },
              ),
            );
            return;
          }
          armIdleTimeout();
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream),
        hashing,
        createWriteStream(temporary, { flags: 'wx' }),
        { signal: transferController.signal },
      );
      if (idleTimeout) clearTimeout(idleTimeout);
      const actualSha256 = digest.digest('hex');
      if (actualSha256 !== expectedSha256 || (expectedSize !== null && byteSize !== expectedSize)) {
        throw new ComposerError(
          'asset_identity_mismatch',
          'Downloaded asset identity mismatch',
          500,
          { diagnostics: diagnostics() },
        );
      }
      const handle = await open(temporary, 'r');
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      options.catalog?.record({
        cacheKey: target,
        cacheKind: options.cacheKind ?? 'source',
        sha256: actualSha256,
        byteSize,
        ...(options.profileIdentity ? { profileIdentity: options.profileIdentity } : {}),
      });
      return { path: target, cacheHit: false, byteSize, sha256: actualSha256 };
    } catch (error) {
      if (idleTimeout) clearTimeout(idleTimeout);
      await unlink(temporary).catch(() => undefined);
      if (error instanceof ComposerError) throw error;
      throw new ComposerError(
        'asset_materialization_failed',
        'Falha ao materializar mídia necessária para o render.',
        502,
        {
          cause: idleTimeoutError ?? error,
          diagnostics: diagnostics(),
        },
      );
    }
  });
};
