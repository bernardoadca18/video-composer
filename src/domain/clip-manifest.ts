import type { AppConfig } from '../core/config.js';
import { fingerprint } from '../core/identity.js';
import type { MediaAssetMetadata } from './contracts.js';
import { type ClipRenderProfile, verticalShortV1 } from './clip-profiles.js';
import { type ClipRenderRequest, ClipContractValidationError } from './clip-contracts.js';
import { secondsToMicroseconds } from './quantization.js';

export const CLIP_PROXY_STRATEGY_V1 = 'clip_source_audio_proxy_v1';

export interface ClipSourceAsset {
  media_id: string;
  sha256: string;
  byte_size: number;
  content_type: string | null;
}

export interface ClipProxyInfo {
  proxy_key: string;
  proxy_url: string;
  source_start_microseconds: number;
  source_end_microseconds: number;
  audio_semantics: 'source_audio';
}

export interface ClipRenderManifest {
  schema_version: 'clip_render_manifest_v1';
  composer_strategy_version: 'video_composer_clip_v1';
  proxy_strategy_version: typeof CLIP_PROXY_STRATEGY_V1;

  clip_composition_id: string;
  clip_composition_fingerprint: string;
  composition_version: number;

  workflow_id: string;
  source_id: string;
  plan_id: string;
  candidate_id: string;
  analysis_id: string | null;

  media_id: string;
  transcription_id: string;

  source_sha256: string;

  source_start_microseconds: number;
  source_end_microseconds: number;

  duration_microseconds: number;
  duration_seconds: number;
  duration_in_frames: number;

  strategy: string;

  render_profile: {
    name: 'vertical_short_v1';
    identity: string;
    width: number;
    height: number;
    fps: number;
    layout_intent: 'portrait_blur_background';
  };

  audio_mode: 'original';
  caption_mode: 'none';

  source_asset: ClipSourceAsset;
  proxy: ClipProxyInfo;
}

export interface BuildClipManifestResult {
  manifest: ClipRenderManifest;
  manifestFingerprint: string;
}

export const buildClipRenderManifest = (
  request: ClipRenderRequest,
  metadata: MediaAssetMetadata,
  profile: ClipRenderProfile,
  config: AppConfig,
): BuildClipManifestResult => {
  if (metadata.id !== request.media_id) {
    throw new ClipContractValidationError(
      'source_identity_mismatch',
      'Media asset ID does not match request media_id',
    );
  }

  if (metadata.sha256 !== request.source_sha256) {
    throw new ClipContractValidationError(
      'source_identity_mismatch',
      'Media asset SHA-256 does not match request source_sha256',
    );
  }

  const sourceStartUs = secondsToMicroseconds(request.source_start_seconds);
  const sourceEndUs = secondsToMicroseconds(request.source_end_seconds);

  if (metadata.duration_seconds !== null) {
    const mediaDurationUs = secondsToMicroseconds(metadata.duration_seconds);
    if (sourceEndUs > mediaDurationUs) {
      throw new ClipContractValidationError(
        'source_range_invalid',
        'source_end_seconds exceeds media duration',
      );
    }
  }

  const durationUs = sourceEndUs - sourceStartUs;
  const durationSeconds = Number(durationUs) / 1_000_000;
  const durationInFrames = Math.ceil((Number(durationUs) * profile.fps) / 1_000_000);

  const proxyKey = fingerprint({
    strategy: CLIP_PROXY_STRATEGY_V1,
    source_sha256: metadata.sha256,
    source_start_microseconds: sourceStartUs.toString(),
    source_end_microseconds: sourceEndUs.toString(),
    fps: profile.fps,
    codec: profile.videoCodec,
    pixel_format: profile.pixelFormat,
    audio_semantics: 'source_audio',
    audio_codec: profile.audioCodec,
    audio_sample_rate: profile.audioSampleRate,
  });

  const manifest: ClipRenderManifest = {
    schema_version: 'clip_render_manifest_v1',
    composer_strategy_version: 'video_composer_clip_v1',
    proxy_strategy_version: CLIP_PROXY_STRATEGY_V1,

    clip_composition_id: request.clip_composition_id,
    clip_composition_fingerprint: request.clip_composition_fingerprint,
    composition_version: request.composition_version,

    workflow_id: request.workflow_id,
    source_id: request.source_id,
    plan_id: request.plan_id,
    candidate_id: request.candidate_id,
    analysis_id: request.analysis_id,

    media_id: request.media_id,
    transcription_id: request.transcription_id,

    source_sha256: request.source_sha256,

    source_start_microseconds: Number(sourceStartUs),
    source_end_microseconds: Number(sourceEndUs),

    duration_microseconds: Number(durationUs),
    duration_seconds: durationSeconds,
    duration_in_frames: durationInFrames,

    strategy: request.strategy,

    render_profile: {
      name: profile.name,
      identity: profile.identity,
      width: profile.width,
      height: profile.height,
      fps: profile.fps,
      layout_intent: profile.layoutIntent,
    },

    audio_mode: 'original',
    caption_mode: 'none',

    source_asset: {
      media_id: metadata.id,
      sha256: metadata.sha256,
      byte_size: metadata.byte_size,
      content_type: metadata.content_type,
    },

    proxy: {
      proxy_key: proxyKey,
      proxy_url: `${config.internalAssetBaseUrl}/internal-assets/clip-proxy/${proxyKey}`,
      source_start_microseconds: Number(sourceStartUs),
      source_end_microseconds: Number(sourceEndUs),
      audio_semantics: 'source_audio',
    },
  };

  const manifestFingerprint = fingerprint(manifest);

  return { manifest, manifestFingerprint };
};

export const resolveClipRenderProfileOrThrow = (name: string): ClipRenderProfile => {
  if (name !== 'vertical_short_v1') {
    throw new ClipContractValidationError(
      'unsupported_clip_feature',
      `Unknown clip render profile: ${name}`,
    );
  }
  return verticalShortV1;
};
