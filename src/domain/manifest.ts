import type { AppConfig } from '../core/config.js';
import { fingerprint } from '../core/identity.js';
import type { RenderProfile } from './profiles.js';
import {
  type MediaAssetMetadata,
  type ProductionTimeline,
  type RenderManifest,
  RenderManifestSchema,
} from './contracts.js';
import { quantizeBoundaries, secondsToMicroseconds } from './quantization.js';

export class ManifestValidationError extends Error {
  constructor(
    public readonly category: string,
    message: string,
  ) {
    super(message);
  }
}

const asNumber = (value: bigint): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new ManifestValidationError('invalid_timeline', 'range');
  return number;
};

const requireTimeline = (
  timeline: ProductionTimeline,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
): void => {
  if (timeline.schema_version !== 'production_timeline_schema_v1') {
    throw new ManifestValidationError('unsupported_timeline_feature', 'Unsupported schema');
  }
  if (!['completed', 'completed_with_gaps'].includes(timeline.status)) {
    throw new ManifestValidationError('invalid_timeline', 'Timeline is not completed');
  }
  if (!timeline.tracks.narration) {
    throw new ManifestValidationError('invalid_timeline', 'Narration is missing');
  }
  const durationUs = secondsToMicroseconds(timeline.duration_seconds);
  const narrationStartUs = secondsToMicroseconds(timeline.tracks.narration.timeline_start_seconds);
  const narrationEndUs = secondsToMicroseconds(timeline.tracks.narration.timeline_end_seconds);
  const narrationSourceStartUs = secondsToMicroseconds(
    timeline.tracks.narration.source_start_seconds,
  );
  const narrationSourceEndUs = secondsToMicroseconds(timeline.tracks.narration.source_end_seconds);
  if (
    narrationStartUs !== 0n ||
    narrationSourceStartUs !== 0n ||
    narrationEndUs !== durationUs ||
    narrationSourceEndUs !== durationUs ||
    (timeline.tracks.narration.sample_rate !== null &&
      timeline.tracks.narration.sample_rate !== profile.audioSampleRate)
  ) {
    throw new ManifestValidationError('invalid_timeline', 'Narration track is inconsistent');
  }
  if (timeline.duration_seconds > config.maxRenderDurationSeconds) {
    throw new ManifestValidationError('render_limit', 'Timeline exceeds maximum duration');
  }
  if (timeline.tracks.primary_visual.placements.length > config.maxPlacements) {
    throw new ManifestValidationError('render_limit', 'Timeline exceeds placement limit');
  }
  if (mode === 'final' && (timeline.gaps.length > 0 || timeline.visual_coverage_ratio !== 1)) {
    throw new ManifestValidationError('forbidden_visual_gap', 'Final mode requires full coverage');
  }
  if (profile.finalGapPolicy !== 'reject') {
    throw new ManifestValidationError('invalid_profile', 'Unsupported final gap policy');
  }
};

export const buildRenderManifest = (
  timeline: ProductionTimeline,
  metadata: ReadonlyMap<string, MediaAssetMetadata>,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
): { manifest: RenderManifest; manifestFingerprint: string; renderFingerprint: string } => {
  requireTimeline(timeline, profile, mode, config);
  const narration = timeline.tracks.narration;
  if (!narration) throw new ManifestValidationError('invalid_timeline', 'Narration is missing');
  const placements = [...timeline.tracks.primary_visual.placements].sort(
    (left, right) => left.order - right.order,
  );
  const gaps = [...timeline.gaps].sort((left, right) => left.order - right.order);
  const boundaries = [
    ...placements.flatMap((item) => [item.timeline_start_seconds, item.timeline_end_seconds]),
    ...gaps.flatMap((item) => [item.timeline_start_seconds, item.timeline_end_seconds]),
  ];
  const quantized = quantizeBoundaries(timeline.duration_seconds, boundaries, profile.fps);
  let previousEndUs = 0n;
  let previousEndFrame = 0;
  const manifestPlacements = placements.map((item) => {
    if (
      item.source.source_type !== 'gameplay' ||
      item.playback_rate !== 1 ||
      item.transition !== 'cut'
    ) {
      throw new ManifestValidationError('unsupported_timeline_feature', 'Unsupported placement');
    }
    const timelineStartUs = secondsToMicroseconds(item.timeline_start_seconds);
    const timelineEndUs = secondsToMicroseconds(item.timeline_end_seconds);
    const candidateStartUs = secondsToMicroseconds(item.source.candidate_start_seconds);
    const candidateEndUs = secondsToMicroseconds(item.source.candidate_end_seconds);
    const sourceStartUs = secondsToMicroseconds(item.source.source_start_seconds);
    const sourceEndUs = secondsToMicroseconds(item.source.source_end_seconds);
    if (
      timelineStartUs < previousEndUs ||
      timelineEndUs <= timelineStartUs ||
      candidateEndUs <= candidateStartUs ||
      sourceStartUs < candidateStartUs ||
      sourceEndUs > candidateEndUs ||
      sourceEndUs <= sourceStartUs ||
      sourceEndUs - sourceStartUs !== timelineEndUs - timelineStartUs
    ) {
      throw new ManifestValidationError('invalid_timeline', 'Invalid placement ranges');
    }
    const frameStart = quantized.frameAt(item.timeline_start_seconds);
    const frameEnd = quantized.frameAt(item.timeline_end_seconds);
    if (frameStart < previousEndFrame || frameEnd <= frameStart) {
      throw new ManifestValidationError('frame_quantization', 'Placement collapsed or overlaps');
    }
    const asset = metadata.get(item.source.media_id);
    if (
      !asset ||
      asset.id !== item.source.media_id ||
      asset.project_id !== item.source.project_id
    ) {
      throw new ManifestValidationError('source_identity', 'Media asset identity mismatch');
    }
    if (
      asset.duration_seconds !== null &&
      sourceEndUs > secondsToMicroseconds(asset.duration_seconds)
    ) {
      throw new ManifestValidationError('source_identity', 'Source trim exceeds media duration');
    }
    const proxyKey = fingerprint({
      strategy: 'clip_proxy_v1',
      source_sha256: asset.sha256,
      source_start_microseconds: sourceStartUs.toString(),
      source_end_microseconds: sourceEndUs.toString(),
      fps: profile.fps,
      codec: 'h264',
      pixel_format: 'yuv420p',
    });
    previousEndUs = timelineEndUs;
    previousEndFrame = frameEnd;
    return {
      id: item.id,
      order: item.order,
      frame_start: frameStart,
      frame_duration: frameEnd - frameStart,
      timeline_start_microseconds: asNumber(timelineStartUs),
      timeline_end_microseconds: asNumber(timelineEndUs),
      source: {
        project_id: item.source.project_id,
        session_id: item.source.session_id,
        media_id: item.source.media_id,
        sha256: asset.sha256,
        candidate_start_microseconds: asNumber(candidateStartUs),
        candidate_end_microseconds: asNumber(candidateEndUs),
        source_start_microseconds: asNumber(sourceStartUs),
        source_end_microseconds: asNumber(sourceEndUs),
        proxy_key: proxyKey,
        proxy_url: `${config.internalAssetBaseUrl}/internal-assets/proxy/${proxyKey}`,
      },
      playback_rate: 1 as const,
      transition: 'cut' as const,
    };
  });
  let previousGapEndUs = 0n;
  const manifestGaps = gaps.map((item) => {
    const gapStartUs = secondsToMicroseconds(item.timeline_start_seconds);
    const gapEndUs = secondsToMicroseconds(item.timeline_end_seconds);
    if (
      gapStartUs < previousGapEndUs ||
      gapEndUs <= gapStartUs ||
      gapEndUs > secondsToMicroseconds(timeline.duration_seconds)
    ) {
      throw new ManifestValidationError('invalid_timeline', 'Invalid gap ranges');
    }
    previousGapEndUs = gapEndUs;
    const frameStart = quantized.frameAt(item.timeline_start_seconds);
    const frameEnd = quantized.frameAt(item.timeline_end_seconds);
    if (frameEnd <= frameStart) {
      throw new ManifestValidationError('frame_quantization', 'Gap collapsed to zero frames');
    }
    return {
      id: item.id,
      order: item.order,
      frame_start: frameStart,
      frame_duration: frameEnd - frameStart,
      reason: item.reason,
      severity: item.severity,
    };
  });
  const expectedGaps: Array<[bigint, bigint]> = [];
  let cursor = 0n;
  for (const item of placements) {
    const start = secondsToMicroseconds(item.timeline_start_seconds);
    const end = secondsToMicroseconds(item.timeline_end_seconds);
    if (start > cursor) expectedGaps.push([cursor, start]);
    cursor = end;
  }
  const durationUs = secondsToMicroseconds(timeline.duration_seconds);
  if (cursor < durationUs) expectedGaps.push([cursor, durationUs]);
  const actualGaps: Array<[bigint, bigint]> = [];
  for (const item of gaps) {
    const start = secondsToMicroseconds(item.timeline_start_seconds);
    const end = secondsToMicroseconds(item.timeline_end_seconds);
    const previous = actualGaps.at(-1);
    if (previous && previous[1] === start) previous[1] = end;
    else actualGaps.push([start, end]);
  }
  if (
    JSON.stringify(expectedGaps.map((item) => item.map(String))) !==
    JSON.stringify(actualGaps.map((item) => item.map(String)))
  ) {
    throw new ManifestValidationError('invalid_timeline', 'Gaps are not the visual complement');
  }
  const uniqueAssets = [...metadata.values()]
    .map((item) => ({
      media_id: item.id,
      project_id: item.project_id,
      sha256: item.sha256,
      byte_size: item.byte_size,
      content_type: item.content_type,
    }))
    .sort((left, right) => left.media_id.localeCompare(right.media_id));
  if (uniqueAssets.length > config.maxSourceAssets) {
    throw new ManifestValidationError('render_limit', 'Timeline exceeds source asset limit');
  }
  const manifest = RenderManifestSchema.parse({
    schema_version: 'render_manifest_v1',
    composer_strategy_version: 'video_composer_v1',
    proxy_strategy_version: 'clip_proxy_v1',
    workflow_id: timeline.workflow_id,
    production_timeline_id: timeline.id,
    production_timeline_fingerprint: timeline.fingerprint,
    mode,
    duration_seconds: timeline.duration_seconds,
    duration_in_frames: quantized.durationInFrames,
    render_profile: {
      name: profile.name,
      identity: profile.identity,
      width: profile.width,
      height: profile.height,
      fps: profile.fps,
      fit_mode: profile.fitMode,
      background_color: profile.backgroundColor,
    },
    narration: {
      sha256: narration.audio_sha256,
      byte_size: narration.byte_size,
      sample_rate: narration.sample_rate,
      channels: narration.channels,
      asset_key: narration.audio_sha256,
      asset_url: `${config.internalAssetBaseUrl}/internal-assets/narration/${narration.audio_sha256}`,
      frame_start: 0,
      frame_duration: quantized.durationInFrames,
    },
    source_assets: uniqueAssets,
    placements: manifestPlacements,
    gaps: manifestGaps,
  });
  const manifestFingerprint = fingerprint(manifest);
  return {
    manifest,
    manifestFingerprint,
    renderFingerprint: fingerprint({
      manifest_fingerprint: manifestFingerprint,
      composer_strategy_version: 'video_composer_v1',
      remotion_version: '4.0.516',
      render_profile_identity: profile.identity,
      mode,
    }),
  };
};
