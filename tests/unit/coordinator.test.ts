import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MediaIndexerClient } from '../../src/clients/media-indexer.js';
import { OrchestratorClient } from '../../src/clients/orchestrator.js';
import { RenderJobRepository } from '../../src/jobs/repository.js';
import type { RenderWorker } from '../../src/jobs/worker.js';
import { RenderCoordinator } from '../../src/services/render-coordinator.js';
import {
  MEDIA_ID,
  mediaMetadata,
  productionTimeline,
  testConfig,
  WORKFLOW_ID,
} from '../helpers.js';

const repositories: RenderJobRepository[] = [];
afterEach(() => repositories.splice(0).forEach((item) => item.close()));

describe('render coordinator', () => {
  it('is idempotent, immutable and performs read-only artifact calls only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-coordinator-'));
    const config = testConfig(root);
    const repository = new RenderJobRepository(config.databasePath);
    repositories.push(repository);
    const timeline = productionTimeline();
    const before = JSON.stringify(timeline);
    const calls: string[] = [];
    let metadata = mediaMetadata();
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/production-timeline')) return Response.json(timeline);
      if (url.endsWith(`/media-assets/${MEDIA_ID}`)) return Response.json(metadata);
      return new Response(null, { status: 404 });
    };
    const enqueued: string[] = [];
    const worker = {
      hasCapacity: true,
      enqueue: (id: string) => {
        enqueued.push(id);
        return true;
      },
    } as unknown as RenderWorker;
    const coordinator = new RenderCoordinator(
      config,
      repository,
      worker,
      new OrchestratorClient(config.orchestratorBaseUrl, 1000, fetchFn),
      new MediaIndexerClient(config.mediaIndexerBaseUrl, 1000, fetchFn),
    );

    const first = await coordinator.ensure(
      { workflow_id: WORKFLOW_ID, render_profile: 'youtube_1080p30_v1', mode: 'final' },
      'same-key',
    );
    const repeated = await coordinator.ensure(
      { workflow_id: WORKFLOW_ID, render_profile: 'youtube_1080p30_v1', mode: 'final' },
      'same-key',
    );

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.job.id).toBe(first.job.id);
    expect(enqueued).toEqual([first.job.id]);
    expect(JSON.stringify(timeline)).toBe(before);
    expect(
      calls.every((url) => url.includes('/production-timeline') || url.includes('/media-assets/')),
    ).toBe(true);
    expect(calls.some((url) => url.includes('search'))).toBe(false);

    repository.complete(
      first.job.id,
      path.join(root, 'missing-output.mp4'),
      { sha256: 'd'.repeat(64) },
      {},
    );
    const repaired = await coordinator.ensure(
      { workflow_id: WORKFLOW_ID, render_profile: 'youtube_1080p30_v1', mode: 'final' },
      'same-key',
    );
    expect(repaired.job.id).toBe(first.job.id);
    expect(repaired.job.status).toBe('queued');
    expect(enqueued).toEqual([first.job.id, first.job.id]);

    await expect(
      coordinator.ensure(
        { workflow_id: WORKFLOW_ID, render_profile: 'youtube_1080p30_v1', mode: 'preview' },
        'same-key',
      ),
    ).rejects.toMatchObject({ category: 'idempotency_conflict' });

    metadata = mediaMetadata({ sha256: 'c'.repeat(64) });
    const changed = await coordinator.ensure(
      { workflow_id: WORKFLOW_ID, render_profile: 'youtube_1080p30_v1', mode: 'final' },
      null,
    );
    expect(changed.job.renderFingerprint).not.toBe(first.job.renderFingerprint);
  });

  it('rejects unknown profiles and a full queue', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-coordinator-'));
    const config = testConfig(root);
    const repository = new RenderJobRepository(config.databasePath);
    repositories.push(repository);
    const fetchFn = async (input: string | URL | Request): Promise<Response> =>
      String(input).includes('/production-timeline')
        ? Response.json(productionTimeline())
        : Response.json(mediaMetadata());
    const coordinator = new RenderCoordinator(
      config,
      repository,
      { hasCapacity: false, enqueue: () => false } as unknown as RenderWorker,
      new OrchestratorClient(config.orchestratorBaseUrl, 1000, fetchFn),
      new MediaIndexerClient(config.mediaIndexerBaseUrl, 1000, fetchFn),
    );

    await expect(
      coordinator.ensure(
        { workflow_id: WORKFLOW_ID, render_profile: 'missing', mode: 'final' },
        null,
      ),
    ).rejects.toMatchObject({ category: 'unknown_render_profile' });
    await expect(
      coordinator.ensure(
        { workflow_id: WORKFLOW_ID, render_profile: 'youtube_1080p30_v1', mode: 'final' },
        null,
      ),
    ).rejects.toMatchObject({ category: 'queue_full' });
  });
});
