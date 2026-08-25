import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { ComposerError } from '../core/errors.js';
import { sha256File } from '../core/identity.js';

export interface CachedFile {
  path: string;
  cacheHit: boolean;
  byteSize: number;
  sha256: string;
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
): Promise<CachedFile | null> => {
  try {
    const details = await stat(target);
    if (!details.isFile() || (expectedSize !== null && details.size !== expectedSize)) return null;
    const actual = await sha256File(target);
    if (actual !== expectedSha256) return null;
    return { path: target, cacheHit: true, byteSize: details.size, sha256: actual };
  } catch {
    return null;
  }
};

export const materializeResponse = async (
  target: string,
  expectedSha256: string,
  expectedSize: number | null,
  responseFactory: () => Promise<Response>,
): Promise<CachedFile> => {
  const lockPath = `${target}.lock`;
  return await withFileLock(lockPath, async () => {
    const cached = await validCachedFile(target, expectedSha256, expectedSize);
    if (cached) return cached;
    await mkdir(path.dirname(target), { recursive: true });
    await unlink(target).catch(() => undefined);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const response = await responseFactory();
      if (!response.body) throw new ComposerError('dependency_contract', 'Empty asset response');
      const digest = createHash('sha256');
      let byteSize = 0;
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          digest.update(chunk);
          byteSize += chunk.length;
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream),
        hashing,
        createWriteStream(temporary, { flags: 'wx' }),
      );
      const actualSha256 = digest.digest('hex');
      if (actualSha256 !== expectedSha256 || (expectedSize !== null && byteSize !== expectedSize)) {
        throw new ComposerError('asset_identity_mismatch', 'Downloaded asset identity mismatch');
      }
      const handle = await open(temporary, 'r');
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      return { path: target, cacheHit: false, byteSize, sha256: actualSha256 };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  });
};
