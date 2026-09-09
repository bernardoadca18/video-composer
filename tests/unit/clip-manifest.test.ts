import { describe, expect, it } from 'vitest';

import type { MediaAssetMetadata } from '../../src/domain/contracts.js';
import {
  type ClipRenderRequest,
  validateClipRenderRequest,
} from '../../src/domain/clip-contracts.js';
import { buildClipRenderManifest, CLIP_PROXY_STRATEGY_V1 } from '../../src/domain/clip-manifest.js';
import type { AppConfig } from '../../src/core/config.js';
import { verticalShortV1 } from '../../src/domain/clip-profiles.js';
import { ClipContractValidationError } from '../../src/domain/clip-contracts.js';

const testConfig: AppConfig = {
  internalAssetBaseUrl: 'http://video-composer:8013',
  proxyCacheRoot: '/tmp/proxies',
  ffmpegBinary: 'ffmpeg',
  ffprobeBinary: 'ffprobe',
  outputRoot: '/tmp/output',
  redisUrl: 'redis://localhost:6379',
  databaseUrl: 'postgresql://localhost:5432/test',
  mediaIndexerBaseUrl: 'http://media-indexer:8012',
  orchestratorBaseUrl: 'http://orchestrator:8014',
  port: 8013,
  logLevel: 'info',
};

const validRequest = (): ClipRenderRequest =>
  validateClipRenderRequest({
    schema_version: 'clip_render_request_v1',
    clip_composition_id: '10000000-0000-4000-8000-000000000001',
    clip_composition_fingerprint: 'a'.repeat(64),
    composition_version: 2,
    workflow_id: '20000000-0000-4000-8000-000000000001',
    source_id: '30000000-0000-4000-8000-000000000001',
    plan_id: '40000000-0000-4000-8000-000000000001',
    candidate_id: '50000000-0000-4000-8000-000000000001',
    analysis_id: '60000000-0000-4000-8000-000000000001',
    media_id: '70000000-0000-4000-8000-000000000001',
    transcription_id: '80000000-0000-4000-8000-000000000001',
    source_sha256: 'b'.repeat(64),
    source_start_seconds: 10.123456,
    source_end_seconds: 47.987654,
    strategy: 'USE_DIRECTLY',
    render_profile: 'vertical_short_v1',
    audio_mode: 'original',
    caption_mode: 'none',
  });

const mediaMetadata = (overrides: Partial<MediaAssetMetadata> = {}): MediaAssetMetadata =>
  ({
    id: '70000000-0000-4000-8000-000000000001',
    project_id: 'test-project',
    original_filename: 'test.mp4',
    sha256: 'b'.repeat(64),
    byte_size: 12345678,
    content_type: 'video/mp4',
    duration_seconds: 120,
    format_name: 'mp4',
    width: 1920,
    height: 1080,
    ...overrides,
  }) as MediaAssetMetadata;

describe('ClipRenderManifest V1', () => {
  it('builds manifest from valid request and metadata', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const result = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(result.manifest.schema_version).toBe('clip_render_manifest_v1');
    expect(result.manifest.composer_strategy_version).toBe('video_composer_clip_v1');
    expect(result.manifest.proxy_strategy_version).toBe(CLIP_PROXY_STRATEGY_V1);
  });

  it('preserves all upstream provenance', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const result = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(result.manifest.clip_composition_id).toBe(request.clip_composition_id);
    expect(result.manifest.clip_composition_fingerprint).toBe(request.clip_composition_fingerprint);
    expect(result.manifest.composition_version).toBe(request.composition_version);
    expect(result.manifest.workflow_id).toBe(request.workflow_id);
    expect(result.manifest.source_id).toBe(request.source_id);
    expect(result.manifest.plan_id).toBe(request.plan_id);
    expect(result.manifest.candidate_id).toBe(request.candidate_id);
    expect(result.manifest.analysis_id).toBe(request.analysis_id);
    expect(result.manifest.media_id).toBe(request.media_id);
    expect(result.manifest.transcription_id).toBe(request.transcription_id);
  });

  it('converts timestamps to microseconds deterministically', () => {
    const request = validRequest();
    request.source_start_seconds = 10.123456;
    request.source_end_seconds = 47.987654;
    const metadata = mediaMetadata();
    const result = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(result.manifest.source_start_microseconds).toBe(10_123_456);
    expect(result.manifest.source_end_microseconds).toBe(47_987_654);
  });

  it('derives duration correctly', () => {
    const request = validRequest();
    request.source_start_seconds = 10;
    request.source_end_seconds = 55;
    const metadata = mediaMetadata();
    const result = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(result.manifest.duration_microseconds).toBe(45_000_000);
    expect(result.manifest.duration_seconds).toBeCloseTo(45, 6);
    expect(result.manifest.duration_in_frames).toBe(1350); // 45 * 30 fps
  });

  it('includes profile identity', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const result = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(result.manifest.render_profile.name).toBe('vertical_short_v1');
    expect(result.manifest.render_profile.identity).toBe(verticalShortV1.identity);
    expect(result.manifest.render_profile.width).toBe(1080);
    expect(result.manifest.render_profile.height).toBe(1920);
    expect(result.manifest.render_profile.fps).toBe(30);
    expect(result.manifest.render_profile.layout_intent).toBe('portrait_blur_background');
  });

  it('creates deterministic manifest fingerprint', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const first = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);
    const second = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(first.manifestFingerprint).toBe(second.manifestFingerprint);
  });

  it('changes fingerprint when source_start changes', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const first = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    request.source_start_seconds = 15;
    const second = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(second.manifestFingerprint).not.toBe(first.manifestFingerprint);
  });

  it('changes fingerprint when source_end changes', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const first = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    request.source_end_seconds = 50;
    const second = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(second.manifestFingerprint).not.toBe(first.manifestFingerprint);
  });

  it('changes fingerprint when source_sha changes', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const first = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    const newSha = 'c'.repeat(64);
    request.source_sha256 = newSha;
    const newMetadata = mediaMetadata({ sha256: newSha });
    const second = buildClipRenderManifest(request, newMetadata, verticalShortV1, testConfig);

    expect(second.manifestFingerprint).not.toBe(first.manifestFingerprint);
  });

  it('changes fingerprint when composition fingerprint changes', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const first = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    request.clip_composition_fingerprint = 'd'.repeat(64);
    const second = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(second.manifestFingerprint).not.toBe(first.manifestFingerprint);
  });

  it('fails on media_id mismatch', () => {
    const request = validRequest();
    const metadata = mediaMetadata({ id: '90000000-0000-4000-8000-000000000001' });

    expect(() => buildClipRenderManifest(request, metadata, verticalShortV1, testConfig)).toThrow(
      ClipContractValidationError,
    );
  });

  it('fails on sha256 mismatch', () => {
    const request = validRequest();
    const metadata = mediaMetadata({ sha256: 'c'.repeat(64) });

    expect(() => buildClipRenderManifest(request, metadata, verticalShortV1, testConfig)).toThrow(
      ClipContractValidationError,
    );
  });

  it('fails when source_end exceeds media duration', () => {
    const request = validRequest();
    request.source_end_seconds = 200;
    const metadata = mediaMetadata({ duration_seconds: 120 });

    expect(() => buildClipRenderManifest(request, metadata, verticalShortV1, testConfig)).toThrow(
      ClipContractValidationError,
    );
  });

  it('succeeds when duration_seconds is null (unknown duration)', () => {
    const request = validRequest();
    const metadata = mediaMetadata({ duration_seconds: null });

    expect(() =>
      buildClipRenderManifest(request, metadata, verticalShortV1, testConfig),
    ).not.toThrow();
  });

  it('includes source asset metadata', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const result = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(result.manifest.source_asset.media_id).toBe(metadata.id);
    expect(result.manifest.source_asset.sha256).toBe(metadata.sha256);
    expect(result.manifest.source_asset.byte_size).toBe(metadata.byte_size);
    expect(result.manifest.source_asset.content_type).toBe(metadata.content_type);
  });

  it('creates proxy key with audio semantics', () => {
    const request = validRequest();
    const metadata = mediaMetadata();
    const result = buildClipRenderManifest(request, metadata, verticalShortV1, testConfig);

    expect(result.manifest.proxy.audio_semantics).toBe('source_audio');
    expect(result.manifest.proxy.source_start_microseconds).toBe(
      result.manifest.source_start_microseconds,
    );
    expect(result.manifest.proxy.source_end_microseconds).toBe(
      result.manifest.source_end_microseconds,
    );
  });
});
