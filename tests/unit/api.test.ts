import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/api/server.js';
import { RenderManifestV5Schema } from '../../src/domain/contracts.js';
import { RenderJobRepository } from '../../src/jobs/repository.js';
import type { RenderCoordinator } from '../../src/services/render-coordinator.js';
import { renderManifest, testConfig, TIMELINE_ID, WORKFLOW_ID } from '../helpers.js';

const repositories: RenderJobRepository[] = [];
afterEach(() => repositories.splice(0).forEach((item) => item.close()));

describe('render API', () => {
  it('provides health, profile and asynchronous job contracts without paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-api-'));
    const config = testConfig(root);
    const repository = new RenderJobRepository(config.databasePath);
    repositories.push(repository);
    const job = repository.create({
      id: '80000000-0000-4000-8000-000000000002',
      workflowId: WORKFLOW_ID,
      productionTimelineId: TIMELINE_ID,
      productionTimelineFingerprint: 'c'.repeat(64),
      renderProfile: 'youtube_1080p30_v1',
      renderProfileIdentity: 'd'.repeat(64),
      mode: 'final',
      idempotencyKey: 'api-key',
      requestFingerprint: 'e'.repeat(64),
      renderFingerprint: 'f'.repeat(64),
      manifestFingerprint: '1'.repeat(64),
      manifest: renderManifest(root),
    });
    let suppliedKey: string | null = null;
    const coordinator = {
      get: (id: string) => repository.get(id),
      ensure: async (_request: unknown, key: string | null) => {
        suppliedKey = key;
        return { job, created: true };
      },
    } as unknown as RenderCoordinator;
    let ready = false;
    const server = buildServer({ config, coordinator, queueDepth: () => 1, isReady: () => ready });

    expect((await server.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
    ready = true;
    expect((await server.inject({ method: 'GET', url: '/health/ready' })).json()).toEqual({
      status: 'ready',
      worker: 'operational',
      queue_depth: 1,
    });
    expect(
      (await server.inject({ method: 'GET', url: '/v1/render-profiles' })).json().items[0].name,
    ).toBe('youtube_1080p30_v1');
    const created = await server.inject({
      method: 'POST',
      url: '/v1/renders',
      headers: { 'idempotency-key': 'api-key' },
      payload: { workflow_id: WORKFLOW_ID, mode: 'final' },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json().status).toBe('queued');
    expect(created.json().presentation_fingerprint).toBeNull();
    const legacy = job.manifest;
    job.manifest = RenderManifestV5Schema.parse({
      ...legacy,
      schema_version: 'render_manifest_v5',
      composer_strategy_version: 'video_composer_v5_asset_sources',
      source_timeline_schema_version: 'production_timeline_schema_v3',
      source_assets: legacy.source_assets.map((asset) => ({ ...asset, media_kind: 'video' })),
      placements: legacy.placements.map((placement) => ({
        ...placement,
        source: { ...placement.source, source_type: 'video_segment' },
        presentation: null,
      })),
      presentation: {
        schema_version: 'presentation_spec_v1',
        strategy_version: 'longform_presentation_v1',
        profile_id: 'longform_professional_v1',
        fingerprint: 'a'.repeat(64),
        captions: null,
        section_titles: [],
        branding: { preset: 'branding_disabled_v1', enabled: false },
        transitions: [],
      },
    });
    const pov = await server.inject({
      method: 'POST',
      url: '/v1/renders',
      headers: { 'idempotency-key': 'api-key' },
      payload: { workflow_id: WORKFLOW_ID, mode: 'final' },
    });
    expect(pov.statusCode).toBe(202);
    expect(pov.json().presentation_fingerprint).toBe('a'.repeat(64));
    expect(created.json().output_path).toBeUndefined();
    expect(suppliedKey).toBe('api-key');
    expect((await server.inject({ method: 'GET', url: `/v1/renders/${job.id}` })).statusCode).toBe(
      200,
    );
    expect(
      (await server.inject({ method: 'GET', url: `/v1/renders/${job.id}/video` })).statusCode,
    ).toBe(409);
    expect(
      (await server.inject({ method: 'GET', url: `/internal-assets/proxy/../../etc/passwd` }))
        .statusCode,
    ).toBe(404);
    await server.close();
  });

  it('returns safe validation and not-found errors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-api-'));
    const config = testConfig(root);
    const coordinator = {
      get: () => null,
      ensure: async () => {
        throw new Error('must not be called');
      },
    } as unknown as RenderCoordinator;
    const server = buildServer({ config, coordinator, queueDepth: () => 0, isReady: () => true });

    const invalid = await server.inject({
      method: 'POST',
      url: '/v1/renders',
      payload: { workflow_id: '../../etc/passwd', mode: 'final' },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toEqual({ error: 'invalid_request', message: 'Request is invalid' });
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/renders/90000000-0000-4000-8000-000000000001',
        })
      ).statusCode,
    ).toBe(404);
    await server.close();
  });
});
