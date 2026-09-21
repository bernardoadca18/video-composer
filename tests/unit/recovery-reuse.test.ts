import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/core/config.js';
import { fingerprint } from '../../src/core/identity.js';
import type { RenderManifestV1 } from '../../src/domain/contracts.js';
import { buildRenderManifest } from '../../src/domain/manifest.js';
import { youtube1080p30V1 } from '../../src/domain/profiles.js';
import {
  canReuseCandidate,
  canReuseVideoOnly,
  cleanupIntermediateRecovery,
  loadRecoveryMetadata,
  markCompleted,
  preserveCandidate,
  preserveVideoOnly,
  saveRecoveryMetadata,
} from '../../src/storage/recovery-artifacts.js';
import { testConfig, TIMELINE_ID, WORKFLOW_ID, PROJECT_ID, SESSION_ID, MEDIA_ID, AUDIO_SHA, MEDIA_SHA } from '../helpers.js';

const createTestConfig = async (): Promise<{ config: AppConfig; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'composer-recovery-'));
  return {
    config: testConfig(root),
    cleanup: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(root, { recursive: true, force: true });
    },
  };
};

const createTestManifest = (root: string): RenderManifestV1 =>
  buildRenderManifest(
    {
      id: TIMELINE_ID,
      workflow_id: WORKFLOW_ID,
      schema_version: 'production_timeline_schema_v1',
      strategy_version: 'production_timeline_v1',
      fingerprint: fingerprint({ timeline: 1 }),
      status: 'completed',
      duration_seconds: 6,
      tracks: {
        narration: {
          kind: 'narration',
          timeline_start_seconds: 0,
          timeline_end_seconds: 6,
          source_start_seconds: 0,
          source_end_seconds: 6,
          audio_url: `/workflow/${WORKFLOW_ID}/audio`,
          audio_sha256: AUDIO_SHA,
          sample_rate: 48_000,
          channels: 1,
          byte_size: 100,
        },
        primary_visual: {
          placements: [
            {
              id: '60000000-0000-4000-8000-000000000001',
              order: 0,
              timeline_start_seconds: 0,
              timeline_end_seconds: 6,
              source: {
                source_type: 'gameplay',
                project_id: PROJECT_ID,
                session_id: SESSION_ID,
                media_id: MEDIA_ID,
                candidate_start_seconds: 10,
                candidate_end_seconds: 16,
                source_start_seconds: 10,
                source_end_seconds: 16,
              },
              playback_rate: 1,
              transition: 'cut',
            },
          ],
        },
      },
      gaps: [],
      visual_coverage_ratio: 1,
    },
    new Map([
      [
        MEDIA_ID,
        {
          id: MEDIA_ID,
          project_id: PROJECT_ID,
          media_kind: 'video',
          original_filename: 'gameplay.mp4',
          content_type: 'video/mp4',
          byte_size: 1234,
          sha256: MEDIA_SHA,
          duration_seconds: 60,
          format_name: 'mov,mp4',
          video_codec: 'h264',
          audio_codec: 'aac',
          fps: 60,
          width: 1920,
          height: 1080,
        },
      ],
    ]),
    youtube1080p30V1,
    'final',
    testConfig(root),
  ).manifest;

describe('recovery artifact reuse', () => {
  let config: AppConfig;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    await cleanup();
  });

  describe('canReuseCandidate', () => {
    it('returns not reusable when no candidate exists', async () => {
      ({ config, cleanup } = await createTestConfig());
      const manifestFingerprint = fingerprint({ manifest: 'test' });

      const result = await canReuseCandidate(config, 'test-render-id', manifestFingerprint);

      expect(result.reusable).toBe(false);
    });

    it('returns not reusable when fingerprint mismatches', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'test-render-id';
      const manifestFingerprint = fingerprint({ manifest: 'v1' });
      const differentFingerprint = fingerprint({ manifest: 'v2' });

      // Create a candidate artifact
      await mkdir(path.join(config.dataRoot, 'recovery', renderId), { recursive: true });
      const candidatePath = path.join(config.dataRoot, 'recovery', renderId, 'candidate.mp4');
      await writeFile(candidatePath, 'fake video content');

      await saveRecoveryMetadata(config, renderId, {
        render_id: renderId,
        manifest_fingerprint: manifestFingerprint,
        render_fingerprint: fingerprint({ render: 1 }),
        created_at: new Date().toISOString(),
        stage: 'mux_completed',
      });

      const result = await canReuseCandidate(config, renderId, differentFingerprint);

      expect(result.reusable).toBe(false);
    });

    it('returns reusable when candidate exists with matching fingerprint', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'test-render-id';
      const manifestFingerprint = fingerprint({ manifest: 'v1' });

      // Create a candidate artifact
      await mkdir(path.join(config.dataRoot, 'recovery', renderId), { recursive: true });
      const candidatePath = path.join(config.dataRoot, 'recovery', renderId, 'candidate.mp4');
      await writeFile(candidatePath, 'fake video content');

      await saveRecoveryMetadata(config, renderId, {
        render_id: renderId,
        manifest_fingerprint: manifestFingerprint,
        render_fingerprint: fingerprint({ render: 1 }),
        created_at: new Date().toISOString(),
        stage: 'mux_completed',
      });

      const result = await canReuseCandidate(config, renderId, manifestFingerprint);

      expect(result.reusable).toBe(true);
      expect(result.path).toBe(candidatePath);
    });
  });

  describe('canReuseVideoOnly', () => {
    it('returns not reusable when no video-only artifact exists', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderFingerprint = fingerprint({ render: 1 });

      const result = await canReuseVideoOnly(config, 'test-render-id', renderFingerprint);

      expect(result.reusable).toBe(false);
    });

    it('returns reusable when video-only exists with matching fingerprint', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'test-render-id';
      const renderFingerprint = fingerprint({ render: 1 });

      // Create a video-only artifact
      await mkdir(path.join(config.dataRoot, 'recovery', renderId), { recursive: true });
      const videoOnlyPath = path.join(config.dataRoot, 'recovery', renderId, 'video-only.mp4');
      await writeFile(videoOnlyPath, 'fake video only content');

      await saveRecoveryMetadata(config, renderId, {
        render_id: renderId,
        manifest_fingerprint: fingerprint({ manifest: 1 }),
        render_fingerprint: renderFingerprint,
        created_at: new Date().toISOString(),
        stage: 'video_rendered',
      });

      const result = await canReuseVideoOnly(config, renderId, renderFingerprint);

      expect(result.reusable).toBe(true);
      expect(result.path).toBe(videoOnlyPath);
    });
  });

  describe('cleanupIntermediateRecovery', () => {
    it('removes both video-only and candidate after successful completion', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'test-render-id';

      // Create recovery artifacts
      await mkdir(path.join(config.dataRoot, 'recovery', renderId), { recursive: true });
      const videoOnlyPath = path.join(config.dataRoot, 'recovery', renderId, 'video-only.mp4');
      const candidatePath = path.join(config.dataRoot, 'recovery', renderId, 'candidate.mp4');
      await writeFile(videoOnlyPath, 'video only');
      await writeFile(candidatePath, 'candidate');

      await markCompleted(config, renderId);
      await cleanupIntermediateRecovery(config, renderId);

      // Verify both files are removed
      const { access } = await import('node:fs/promises');
      await expect(access(videoOnlyPath)).rejects.toThrow();
      await expect(access(candidatePath)).rejects.toThrow();
    });
  });

  describe('saveRecoveryMetadata with validation diagnostics', () => {
    it('persists validation diagnostics when candidate fails', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'test-render-id';

      await saveRecoveryMetadata(config, renderId, {
        render_id: renderId,
        manifest_fingerprint: fingerprint({ manifest: 1 }),
        render_fingerprint: fingerprint({ render: 1 }),
        created_at: new Date().toISOString(),
        stage: 'validation_failed',
        error: {
          category: 'output_validation_failure',
          message: 'Frame count mismatch',
        },
        validation_diagnostics: {
          expected_frame_count: 180,
          actual_frame_count: 179,
          frame_delta: -1,
          expected_duration_seconds: 6,
          actual_duration_seconds: 5.967,
          duration_delta_seconds: -0.033,
          duration_tolerance_seconds: 0.038,
          expected_fps: 30,
          actual_fps: 30,
          video_codec: 'h264',
          pixel_format: 'yuv420p',
          width: 1920,
          height: 1080,
          audio_codec: 'aac',
          audio_sample_rate: 48000,
          audio_channels: 1,
          mismatches: ['frame_count'],
        },
      });

      const metadata = await loadRecoveryMetadata(config, renderId);

      expect(metadata?.stage).toBe('validation_failed');
      expect(metadata?.error?.category).toBe('output_validation_failure');
      expect(metadata?.validation_diagnostics?.expected_frame_count).toBe(180);
      expect(metadata?.validation_diagnostics?.actual_frame_count).toBe(179);
      expect(metadata?.validation_diagnostics?.mismatches).toEqual(['frame_count']);
    });
  });
});
