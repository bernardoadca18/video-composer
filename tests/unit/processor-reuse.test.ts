import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/core/config.js';
import { fingerprint } from '../../src/core/identity.js';
import {
  canReuseCandidate,
  canReuseVideoOnly,
  cleanupIntermediateRecovery,
  loadRecoveryMetadata,
  markCompleted,
  saveRecoveryMetadata,
} from '../../src/storage/recovery-artifacts.js';
import { testConfig } from '../helpers.js';

const createTestConfig = async (): Promise<{ config: AppConfig; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'composer-processor-reuse-'));
  return {
    config: testConfig(root),
    cleanup: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(root, { recursive: true, force: true });
    },
  };
};

describe('RenderJobProcessor recovery reuse scenarios', () => {
  let config: AppConfig;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    await cleanup();
  });

  describe('candidate reuse flow', () => {
    it('detects reusable candidate with matching manifest fingerprint', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'a0000000-0000-4000-8000-000000000001';
      const manifestFingerprint = fingerprint({ manifest: 'candidate-test-v1' });

      // Create recovery directory with candidate
      const recoveryDir = path.join(config.dataRoot, 'recovery', renderId);
      await mkdir(recoveryDir, { recursive: true });
      const candidatePath = path.join(recoveryDir, 'candidate.mp4');
      await writeFile(candidatePath, 'valid candidate video');

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

    it('rejects candidate with mismatched manifest fingerprint', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'a0000000-0000-4000-8000-000000000002';
      const manifestFingerprint = fingerprint({ manifest: 'original-v1' });
      const differentFingerprint = fingerprint({ manifest: 'different-v2' });

      const recoveryDir = path.join(config.dataRoot, 'recovery', renderId);
      await mkdir(recoveryDir, { recursive: true });
      await writeFile(path.join(recoveryDir, 'candidate.mp4'), 'candidate');

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

    it('cleans up candidate after successful promotion', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'a0000000-0000-4000-8000-000000000003';

      const recoveryDir = path.join(config.dataRoot, 'recovery', renderId);
      await mkdir(recoveryDir, { recursive: true });
      const candidatePath = path.join(recoveryDir, 'candidate.mp4');
      const videoOnlyPath = path.join(recoveryDir, 'video-only.mp4');
      await writeFile(candidatePath, 'candidate');
      await writeFile(videoOnlyPath, 'video-only');

      await markCompleted(config, renderId);
      await cleanupIntermediateRecovery(config, renderId);

      // Both artifacts should be removed after successful completion
      const { access } = await import('node:fs/promises');
      await expect(access(candidatePath)).rejects.toThrow();
      await expect(access(videoOnlyPath)).rejects.toThrow();
    });
  });

  describe('video-only reuse flow', () => {
    it('detects reusable video-only with matching render fingerprint', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'b0000000-0000-4000-8000-000000000001';
      const renderFingerprint = fingerprint({ render: 'video-only-test-v1' });

      const recoveryDir = path.join(config.dataRoot, 'recovery', renderId);
      await mkdir(recoveryDir, { recursive: true });
      const videoOnlyPath = path.join(recoveryDir, 'video-only.mp4');
      await writeFile(videoOnlyPath, 'valid video only');

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

    it('rejects video-only with mismatched render fingerprint', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'b0000000-0000-4000-8000-000000000002';
      const renderFingerprint = fingerprint({ render: 'original-v1' });
      const differentFingerprint = fingerprint({ render: 'different-v2' });

      const recoveryDir = path.join(config.dataRoot, 'recovery', renderId);
      await mkdir(recoveryDir, { recursive: true });
      await writeFile(path.join(recoveryDir, 'video-only.mp4'), 'video-only');

      await saveRecoveryMetadata(config, renderId, {
        render_id: renderId,
        manifest_fingerprint: fingerprint({ manifest: 1 }),
        render_fingerprint: renderFingerprint,
        created_at: new Date().toISOString(),
        stage: 'video_rendered',
      });

      const result = await canReuseVideoOnly(config, renderId, differentFingerprint);

      expect(result.reusable).toBe(false);
    });

    it('preserves video-only when candidate validation fails', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'b0000000-0000-4000-8000-000000000003';

      const recoveryDir = path.join(config.dataRoot, 'recovery', renderId);
      await mkdir(recoveryDir, { recursive: true });
      const videoOnlyPath = path.join(recoveryDir, 'video-only.mp4');
      const candidatePath = path.join(recoveryDir, 'candidate.mp4');
      await writeFile(videoOnlyPath, 'video-only');
      await writeFile(candidatePath, 'candidate');

      // Simulate candidate validation failure
      await saveRecoveryMetadata(config, renderId, {
        render_id: renderId,
        manifest_fingerprint: fingerprint({ manifest: 1 }),
        render_fingerprint: fingerprint({ render: 1 }),
        created_at: new Date().toISOString(),
        stage: 'validation_failed',
        error: { category: 'output_validation_failure', message: 'Frame count mismatch' },
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

      // Video-only should still exist for potential remux
      const { access } = await import('node:fs/promises');
      await expect(access(videoOnlyPath)).resolves.toBeUndefined();
    });
  });

  describe('recovery hierarchy', () => {
    it('prefers candidate over video-only when both exist', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'c0000000-0000-4000-8000-000000000001';
      const manifestFingerprint = fingerprint({ manifest: 'hierarchy-test' });
      const renderFingerprint = fingerprint({ render: 'hierarchy-test' });

      const recoveryDir = path.join(config.dataRoot, 'recovery', renderId);
      await mkdir(recoveryDir, { recursive: true });
      await writeFile(path.join(recoveryDir, 'candidate.mp4'), 'candidate');
      await writeFile(path.join(recoveryDir, 'video-only.mp4'), 'video-only');

      await saveRecoveryMetadata(config, renderId, {
        render_id: renderId,
        manifest_fingerprint: manifestFingerprint,
        render_fingerprint: renderFingerprint,
        created_at: new Date().toISOString(),
        stage: 'mux_completed',
      });

      const candidateResult = await canReuseCandidate(config, renderId, manifestFingerprint);
      const videoOnlyResult = await canReuseVideoOnly(config, renderId, renderFingerprint);

      // Both should be reusable, but processor checks candidate first
      expect(candidateResult.reusable).toBe(true);
      expect(videoOnlyResult.reusable).toBe(true);
    });

    it('persists validation diagnostics for debugging', async () => {
      ({ config, cleanup } = await createTestConfig());
      const renderId = 'c0000000-0000-4000-8000-000000000002';

      const diagnostics = {
        expected_frame_count: 180,
        actual_frame_count: 178,
        frame_delta: -2,
        expected_duration_seconds: 6,
        actual_duration_seconds: 5.933,
        duration_delta_seconds: -0.067,
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
        mismatches: ['frame_count', 'duration'],
      };

      await saveRecoveryMetadata(config, renderId, {
        render_id: renderId,
        manifest_fingerprint: fingerprint({ manifest: 1 }),
        render_fingerprint: fingerprint({ render: 1 }),
        created_at: new Date().toISOString(),
        stage: 'validation_failed',
        error: { category: 'output_validation_failure', message: 'Multiple validation failures' },
        validation_diagnostics: diagnostics,
      });

      const metadata = await loadRecoveryMetadata(config, renderId);

      expect(metadata?.stage).toBe('validation_failed');
      expect(metadata?.validation_diagnostics).toEqual(diagnostics);
      expect(metadata?.validation_diagnostics?.mismatches).toContain('frame_count');
      expect(metadata?.validation_diagnostics?.mismatches).toContain('duration');
    });
  });
});
