import { describe, expect, it } from 'vitest';

import { fingerprint } from '../../src/core/identity.js';
import { youtube1080p30V1 } from '../../src/domain/profiles.js';
import { verticalShortV1 } from '../../src/domain/clip-profiles.js';
import { CLIP_PROXY_STRATEGY_V1 } from '../../src/domain/clip-manifest.js';

describe('profile identity regression', () => {
  it('preserves youtube_1080p30_v1 identity unchanged', () => {
    const expectedFields = {
      name: 'youtube_1080p30_v1',
      version: 'render_profile_v1',
      width: 1920,
      height: 1080,
      fps: 30,
      container: 'mp4',
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      crf: 18,
      audioCodec: 'aac',
      audioBitrate: '192k',
      audioSampleRate: 48000,
      fitMode: 'contain',
      backgroundColor: '#000000',
      finalGapPolicy: 'reject',
      previewGapPolicy: 'diagnostic_black',
    };

    expect(youtube1080p30V1.name).toBe(expectedFields.name);
    expect(youtube1080p30V1.version).toBe(expectedFields.version);
    expect(youtube1080p30V1.width).toBe(expectedFields.width);
    expect(youtube1080p30V1.height).toBe(expectedFields.height);
    expect(youtube1080p30V1.fps).toBe(expectedFields.fps);
    expect(youtube1080p30V1.container).toBe(expectedFields.container);
    expect(youtube1080p30V1.videoCodec).toBe(expectedFields.videoCodec);
    expect(youtube1080p30V1.pixelFormat).toBe(expectedFields.pixelFormat);
    expect(youtube1080p30V1.crf).toBe(expectedFields.crf);
    expect(youtube1080p30V1.audioCodec).toBe(expectedFields.audioCodec);
    expect(youtube1080p30V1.audioBitrate).toBe(expectedFields.audioBitrate);
    expect(youtube1080p30V1.audioSampleRate).toBe(expectedFields.audioSampleRate);
    expect(youtube1080p30V1.fitMode).toBe(expectedFields.fitMode);
    expect(youtube1080p30V1.backgroundColor).toBe(expectedFields.backgroundColor);
    expect(youtube1080p30V1.finalGapPolicy).toBe(expectedFields.finalGapPolicy);
    expect(youtube1080p30V1.previewGapPolicy).toBe(expectedFields.previewGapPolicy);

    const computedIdentity = fingerprint(expectedFields);
    expect(youtube1080p30V1.identity).toBe(computedIdentity);
  });

  it('creates distinct identity for vertical_short_v1', () => {
    expect(verticalShortV1.name).toBe('vertical_short_v1');
    expect(verticalShortV1.version).toBe('clip_render_profile_v1');
    expect(verticalShortV1.width).toBe(1080);
    expect(verticalShortV1.height).toBe(1920);
    expect(verticalShortV1.fps).toBe(30);
    expect(verticalShortV1.layoutIntent).toBe('portrait_blur_background');
    expect(verticalShortV1.identity).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('cache key isolation', () => {
  it('produces different proxy keys for timeline silent vs clip source-audio proxies', () => {
    const sourceSha = 'b'.repeat(64);
    const sourceStartUs = '10000000';
    const sourceEndUs = '47000000';
    const fps = 30;

    const timelineSilentKey = fingerprint({
      strategy: 'clip_proxy_v1',
      source_sha256: sourceSha,
      source_start_microseconds: sourceStartUs,
      source_end_microseconds: sourceEndUs,
      fps,
      codec: 'h264',
      pixel_format: 'yuv420p',
    });

    const clipSourceAudioKey = fingerprint({
      strategy: CLIP_PROXY_STRATEGY_V1,
      source_sha256: sourceSha,
      source_start_microseconds: sourceStartUs,
      source_end_microseconds: sourceEndUs,
      fps,
      codec: 'h264',
      pixel_format: 'yuv420p',
      audio_semantics: 'source_audio',
      audio_codec: 'aac',
      audio_sample_rate: 48000,
    });

    expect(timelineSilentKey).not.toBe(clipSourceAudioKey);
  });

  it('produces different proxy keys for same strategy but different ranges', () => {
    const sourceSha = 'b'.repeat(64);
    const fps = 30;

    const key1 = fingerprint({
      strategy: CLIP_PROXY_STRATEGY_V1,
      source_sha256: sourceSha,
      source_start_microseconds: '10000000',
      source_end_microseconds: '47000000',
      fps,
      codec: 'h264',
      pixel_format: 'yuv420p',
      audio_semantics: 'source_audio',
      audio_codec: 'aac',
      audio_sample_rate: 48000,
    });

    const key2 = fingerprint({
      strategy: CLIP_PROXY_STRATEGY_V1,
      source_sha256: sourceSha,
      source_start_microseconds: '15000000',
      source_end_microseconds: '50000000',
      fps,
      codec: 'h264',
      pixel_format: 'yuv420p',
      audio_semantics: 'source_audio',
      audio_codec: 'aac',
      audio_sample_rate: 48000,
    });

    expect(key1).not.toBe(key2);
  });

  it('produces different proxy keys for same range but different source SHA', () => {
    const sourceStartUs = '10000000';
    const sourceEndUs = '47000000';
    const fps = 30;

    const key1 = fingerprint({
      strategy: CLIP_PROXY_STRATEGY_V1,
      source_sha256: 'a'.repeat(64),
      source_start_microseconds: sourceStartUs,
      source_end_microseconds: sourceEndUs,
      fps,
      codec: 'h264',
      pixel_format: 'yuv420p',
      audio_semantics: 'source_audio',
      audio_codec: 'aac',
      audio_sample_rate: 48000,
    });

    const key2 = fingerprint({
      strategy: CLIP_PROXY_STRATEGY_V1,
      source_sha256: 'b'.repeat(64),
      source_start_microseconds: sourceStartUs,
      source_end_microseconds: sourceEndUs,
      fps,
      codec: 'h264',
      pixel_format: 'yuv420p',
      audio_semantics: 'source_audio',
      audio_codec: 'aac',
      audio_sample_rate: 48000,
    });

    expect(key1).not.toBe(key2);
  });
});
