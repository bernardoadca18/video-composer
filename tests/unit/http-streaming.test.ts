import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MediaIndexerClient } from '../../src/clients/media-indexer.js';
import { ComposerError } from '../../src/core/errors.js';
import { materializeResponse } from '../../src/storage/atomic-cache.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        async (server) =>
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

describe('control-plane and asset data-plane timeouts', () => {
  it('times out a control request that hangs before headers', async () => {
    const server = createServer(() => undefined);
    const client = new MediaIndexerClient(await listen(server), 25);
    const started = performance.now();

    await expect(client.getMetadata('50000000-0000-4000-8000-000000000001')).rejects.toMatchObject({
      category: 'dependency_unavailable',
    });
    expect(performance.now() - started).toBeLessThan(500);
  }, 15_000);

  it('allows a continuously streaming body to outlive the control timeout', async () => {
    const chunks = ['large-', 'asset-', 'keeps-', 'making-', 'steady-', 'progress'];
    const content = Buffer.from(chunks.join(''));
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-length': content.length });
      let index = 0;
      const interval = setInterval(() => {
        response.write(chunks[index]);
        index += 1;
        if (index === chunks.length) {
          clearInterval(interval);
          response.end();
        }
      }, 15);
      response.on('close', () => clearInterval(interval));
    });
    const client = new MediaIndexerClient(await listen(server), 25);
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-stream-'));
    const target = path.join(root, 'asset.media');
    const sha256 = createHash('sha256').update(content).digest('hex');

    const result = await materializeResponse(
      target,
      sha256,
      content.length,
      async (signal) => await client.openContent('50000000-0000-4000-8000-000000000001', signal),
      {
        idleTimeoutMs: 40,
        maximumBytes: content.length,
        context: {
          sourceKind: 'gameplay',
          mediaId: '50000000-0000-4000-8000-000000000001',
        },
      },
    );

    expect(result.cacheHit).toBe(false);
    expect(await readFile(target)).toEqual(content);
  }, 15_000);

  it('rejects a stalled body, removes the partial file, and succeeds on retry', async () => {
    const content = Buffer.from('complete-content');
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-length': content.length });
      if (requests === 1) {
        response.write(content.subarray(0, 4));
        return;
      }
      response.end(content);
    });
    const client = new MediaIndexerClient(await listen(server), 100);
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-stall-'));
    const target = path.join(root, 'asset.media');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const resolve = async () =>
      await materializeResponse(
        target,
        sha256,
        content.length,
        async (signal) => await client.openContent('50000000-0000-4000-8000-000000000001', signal),
        {
          idleTimeoutMs: 25,
          maximumBytes: content.length,
          context: {
            sourceKind: 'gameplay',
            mediaId: '50000000-0000-4000-8000-000000000001',
          },
        },
      );

    await expect(resolve()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ComposerError &&
        error.category === 'asset_materialization_failed' &&
        error.diagnostics.bytes_written === 4,
    );
    expect(await readdir(root)).toEqual([]);

    const retried = await resolve();
    expect(retried.cacheHit).toBe(false);
    expect(await readFile(target)).toEqual(content);

    const reused = await resolve();
    expect(reused.cacheHit).toBe(true);
    expect(requests).toBe(2);
  }, 15_000);
});
