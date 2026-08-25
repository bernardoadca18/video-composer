import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RenderJobRepository } from '../../src/jobs/repository.js';
import { renderManifest, testConfig, TIMELINE_ID, WORKFLOW_ID } from '../helpers.js';

const repositories: RenderJobRepository[] = [];

afterEach(() => {
  repositories.splice(0).forEach((item) => item.close());
});

describe('render repository', () => {
  it('persists jobs and recovery state across reopen', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-db-'));
    const config = testConfig(root);
    const first = new RenderJobRepository(config.databasePath);
    repositories.push(first);
    const job = first.create({
      id: '80000000-0000-4000-8000-000000000001',
      workflowId: WORKFLOW_ID,
      productionTimelineId: TIMELINE_ID,
      productionTimelineFingerprint: 'c'.repeat(64),
      renderProfile: 'youtube_1080p30_v1',
      renderProfileIdentity: 'd'.repeat(64),
      mode: 'final',
      idempotencyKey: 'stable-key',
      requestFingerprint: 'e'.repeat(64),
      renderFingerprint: 'f'.repeat(64),
      manifestFingerprint: '1'.repeat(64),
      manifest: renderManifest(root),
    });
    first.updateProgress(job.id, 'rendering', 0.5, 20);
    first.close();
    repositories.pop();

    const reopened = new RenderJobRepository(config.databasePath);
    repositories.push(reopened);
    expect(reopened.get(job.id)?.status).toBe('rendering');
    expect(reopened.byIdempotencyKey('stable-key')?.id).toBe(job.id);
    expect(reopened.recoverable().map((item) => item.id)).toEqual([job.id]);
    reopened.requeue(job.id);
    expect(reopened.get(job.id)?.status).toBe('queued');
  });
});
