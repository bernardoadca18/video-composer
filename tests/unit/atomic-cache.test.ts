import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { materializeResponse } from '../../src/storage/atomic-cache.js';

describe('atomic content cache', () => {
  it('serializes concurrent downloads and detects corrupt cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-cache-'));
    const target = path.join(root, 'asset.media');
    const content = Buffer.from('managed gameplay source');
    const sha = createHash('sha256').update(content).digest('hex');
    let downloads = 0;
    const response = async (): Promise<Response> => {
      downloads += 1;
      return new Response(content);
    };

    const [first, second] = await Promise.all([
      materializeResponse(target, sha, content.length, response),
      materializeResponse(target, sha, content.length, response),
    ]);

    expect(downloads).toBe(1);
    expect([first.cacheHit, second.cacheHit].sort()).toEqual([false, true]);
    expect(await readFile(target)).toEqual(content);

    await writeFile(target, Buffer.alloc(content.length, 1));
    const rebuilt = await materializeResponse(target, sha, content.length, response);
    expect(rebuilt.cacheHit).toBe(false);
    expect(downloads).toBe(2);
    expect(await readFile(target)).toEqual(content);
  });

  it('never publishes a checksum mismatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-cache-'));
    const target = path.join(root, 'asset.media');
    await expect(
      materializeResponse(target, '0'.repeat(64), null, async () => new Response('wrong')),
    ).rejects.toThrow('Downloaded asset identity mismatch');
    await expect(readFile(target)).rejects.toThrow();
  });
});
