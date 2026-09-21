import type { AppConfig } from '../core/config.js';
import { fingerprint } from '../core/identity.js';
import type { RenderProfile } from './profiles.js';
import { planProxyDerivatives } from './proxy-planner.js';
import { proxyProfileForRender } from './proxy-profile.js';
import {
  type MediaAssetMetadata,
  type AudioMixPlan,
  type PresentationSpec,
  type ProductionTimeline,
  type RenderManifest,
  type RenderManifestV1,
  type RenderManifestV2,
  type RenderManifestV3,
  type RenderManifestV4,
  AudioMixPlanSchema,
  PresentationSpecSchema,
  RenderManifestV1Schema,
  RenderManifestV2Schema,
  RenderManifestV3Schema,
  RenderManifestV4Schema,
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

interface PlannableVideoSource {
  sha256: string;
  source_start_microseconds: number;
  source_end_microseconds: number;
  proxy_key: string;
  proxy_url: string;
}

const hasPlannableVideoSource = <T extends { source: object }>(
  placement: T,
): placement is T & { source: PlannableVideoSource } => 'proxy_key' in placement.source;

const applyProxyPlan = <T extends { id: string; source: object }>(
  placements: T[],
  profile: RenderProfile,
  config: AppConfig,
): T[] => {
  const proxyProfile = proxyProfileForRender(profile);
  const plan = planProxyDerivatives(
    placements.filter(hasPlannableVideoSource).map((placement) => ({
      placementId: placement.id,
      sourceSha256: placement.source.sha256,
      sourceStartMicroseconds: placement.source.source_start_microseconds,
      sourceEndMicroseconds: placement.source.source_end_microseconds,
    })),
    proxyProfile,
  );
  return placements.map((placement) => {
    if (!hasPlannableVideoSource(placement)) return placement;
    const planned = plan.placements.get(placement.id);
    if (!planned) throw new ManifestValidationError('proxy_plan_invalid', 'Placement is unplanned');
    return {
      ...placement,
      source: {
        ...placement.source,
        proxy_key: planned.derivativeKey,
        proxy_url: `${config.internalAssetBaseUrl}/internal-assets/proxy/${planned.derivativeKey}`,
        proxy_profile_identity: proxyProfile.identity,
        derivative_source_start_microseconds: planned.derivativeStartMicroseconds,
        derivative_source_end_microseconds: planned.derivativeEndMicroseconds,
        proxy_trim_start_microseconds: planned.trimStartMicroseconds,
        proxy_trim_end_microseconds: planned.trimEndMicroseconds,
        proxy_trim_start_frame: planned.trimStartFrame,
      },
    };
  });
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

const buildRenderManifestV1 = (
  timeline: Extract<ProductionTimeline, { schema_version: 'production_timeline_schema_v1' }>,
  metadata: ReadonlyMap<string, MediaAssetMetadata>,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
): { manifest: RenderManifestV1; manifestFingerprint: string; renderFingerprint: string } => {
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
  const plannedPlacements = applyProxyPlan(manifestPlacements, profile, config);
  const manifest = RenderManifestV1Schema.parse({
    schema_version: 'render_manifest_v1',
    composer_strategy_version: 'video_composer_v1',
    proxy_strategy_version: 'proxy_strategy_v2',
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
    placements: plannedPlacements,
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

const buildRenderManifestV2 = (
  timeline: Extract<ProductionTimeline, { schema_version: 'production_timeline_schema_v2' }>,
  metadata: ReadonlyMap<string, MediaAssetMetadata>,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
): { manifest: RenderManifestV2; manifestFingerprint: string; renderFingerprint: string } => {
  if (!['completed', 'completed_with_gaps'].includes(timeline.status)) {
    throw new ManifestValidationError('invalid_timeline', 'Timeline is not completed');
  }
  const narration = timeline.tracks.narration;
  if (!narration) throw new ManifestValidationError('invalid_timeline', 'Narration is missing');
  const durationUs = secondsToMicroseconds(timeline.duration_seconds);
  if (
    secondsToMicroseconds(narration.timeline_start_seconds) !== 0n ||
    secondsToMicroseconds(narration.source_start_seconds) !== 0n ||
    secondsToMicroseconds(narration.timeline_end_seconds) !== durationUs ||
    secondsToMicroseconds(narration.source_end_seconds) !== durationUs
  ) {
    throw new ManifestValidationError('invalid_timeline', 'Narration track is inconsistent');
  }
  if (timeline.duration_seconds > config.maxRenderDurationSeconds) {
    throw new ManifestValidationError('render_limit', 'Timeline exceeds maximum duration');
  }
  const placements = [...timeline.tracks.primary_visual.placements].sort(
    (left, right) => left.order - right.order,
  );
  const gaps = [...timeline.gaps].sort((left, right) => left.order - right.order);
  if (placements.length > config.maxPlacements) {
    throw new ManifestValidationError('render_limit', 'Timeline exceeds placement limit');
  }
  if (mode === 'final' && (gaps.length > 0 || timeline.visual_coverage_ratio !== 1)) {
    throw new ManifestValidationError('forbidden_visual_gap', 'Final mode requires full coverage');
  }
  const boundaries = [
    ...placements.flatMap((item) => [item.timeline_start_seconds, item.timeline_end_seconds]),
    ...gaps.flatMap((item) => [item.timeline_start_seconds, item.timeline_end_seconds]),
  ];
  const quantized = quantizeBoundaries(timeline.duration_seconds, boundaries, profile.fps);
  let previousEndUs = 0n;
  let previousEndFrame = 0;
  const manifestPlacements = placements.map((item) => {
    const timelineStartUs = secondsToMicroseconds(item.timeline_start_seconds);
    const timelineEndUs = secondsToMicroseconds(item.timeline_end_seconds);
    const frameStart = quantized.frameAt(item.timeline_start_seconds);
    const frameEnd = quantized.frameAt(item.timeline_end_seconds);
    if (
      timelineStartUs < previousEndUs ||
      timelineEndUs <= timelineStartUs ||
      timelineEndUs > durationUs ||
      frameStart < previousEndFrame ||
      frameEnd <= frameStart ||
      item.transition !== 'cut'
    ) {
      throw new ManifestValidationError('invalid_timeline', 'Invalid placement range');
    }
    const asset = metadata.get(item.source.media_id);
    if (
      !asset ||
      asset.id !== item.source.media_id ||
      asset.project_id !== item.source.project_id
    ) {
      throw new ManifestValidationError('source_identity', 'Media asset identity mismatch');
    }
    const base = {
      id: item.id,
      order: item.order,
      frame_start: frameStart,
      frame_duration: frameEnd - frameStart,
      timeline_start_microseconds: asNumber(timelineStartUs),
      timeline_end_microseconds: asNumber(timelineEndUs),
      transition: 'cut' as const,
    };
    previousEndUs = timelineEndUs;
    previousEndFrame = frameEnd;
    if (item.source.source_type === 'static_image') {
      if (
        asset.media_kind !== 'image' ||
        asset.sha256 !== item.source.expected_sha256 ||
        asset.byte_size !== item.source.expected_byte_size ||
        asset.content_type !== item.source.content_type
      ) {
        throw new ManifestValidationError('source_identity', 'Static image contract is invalid');
      }
      return {
        ...base,
        source: {
          source_type: 'static_image' as const,
          project_id: item.source.project_id,
          media_id: item.source.media_id,
          image_semantic_index_id: item.source.image_semantic_index_id,
          sha256: asset.sha256,
          byte_size: asset.byte_size,
          content_type: item.source.content_type,
          asset_url:
            `${config.internalAssetBaseUrl}/internal-assets/image/${asset.sha256}` +
            `?content_type=${encodeURIComponent(item.source.content_type)}`,
        },
        playback_rate: null,
        presentation: item.presentation,
      };
    }
    const candidateStartUs = secondsToMicroseconds(item.source.candidate_start_seconds);
    const candidateEndUs = secondsToMicroseconds(item.source.candidate_end_seconds);
    const sourceStartUs = secondsToMicroseconds(item.source.source_start_seconds);
    const sourceEndUs = secondsToMicroseconds(item.source.source_end_seconds);
    if (
      item.playback_rate !== 1 ||
      asset.media_kind !== 'video' ||
      candidateEndUs <= candidateStartUs ||
      sourceStartUs < candidateStartUs ||
      sourceEndUs > candidateEndUs ||
      sourceEndUs - sourceStartUs !== timelineEndUs - timelineStartUs ||
      (asset.duration_seconds !== null &&
        sourceEndUs > secondsToMicroseconds(asset.duration_seconds))
    ) {
      throw new ManifestValidationError('source_identity', 'Video segment contract is invalid');
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
    return {
      ...base,
      source: {
        source_type: 'video_segment' as const,
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
      presentation: null,
    };
  });
  const manifestGaps = gaps.map((item) => {
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
  let gapCursor = 0n;
  for (const item of placements) {
    const start = secondsToMicroseconds(item.timeline_start_seconds);
    const end = secondsToMicroseconds(item.timeline_end_seconds);
    if (start > gapCursor) expectedGaps.push([gapCursor, start]);
    gapCursor = end;
  }
  if (gapCursor < durationUs) expectedGaps.push([gapCursor, durationUs]);
  const actualGaps = gaps.map(
    (item) =>
      [
        secondsToMicroseconds(item.timeline_start_seconds),
        secondsToMicroseconds(item.timeline_end_seconds),
      ] as [bigint, bigint],
  );
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
      media_kind: item.media_kind,
      sha256: item.sha256,
      byte_size: item.byte_size,
      content_type: item.content_type,
    }))
    .sort((left, right) => left.media_id.localeCompare(right.media_id));
  if (uniqueAssets.length > config.maxSourceAssets) {
    throw new ManifestValidationError('render_limit', 'Timeline exceeds source asset limit');
  }
  const plannedPlacements = applyProxyPlan(manifestPlacements, profile, config);
  const manifest = RenderManifestV2Schema.parse({
    schema_version: 'render_manifest_v2',
    composer_strategy_version: 'video_composer_v2_hybrid_sources',
    proxy_strategy_version: 'proxy_strategy_v2',
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
    placements: plannedPlacements,
    gaps: manifestGaps,
  });
  const manifestFingerprint = fingerprint(manifest);
  return {
    manifest,
    manifestFingerprint,
    renderFingerprint: fingerprint({
      manifest_fingerprint: manifestFingerprint,
      composer_strategy_version: 'video_composer_v2_hybrid_sources',
      remotion_version: '4.0.516',
      render_profile_identity: profile.identity,
      mode,
    }),
  };
};

export function buildRenderManifest(
  timeline: ProductionTimeline,
  metadata: ReadonlyMap<string, MediaAssetMetadata>,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
  presentation: PresentationSpec | null,
  audioMixPlan: AudioMixPlan,
): { manifest: RenderManifestV4; manifestFingerprint: string; renderFingerprint: string };
export function buildRenderManifest(
  timeline: ProductionTimeline,
  metadata: ReadonlyMap<string, MediaAssetMetadata>,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
  presentation: PresentationSpec,
): { manifest: RenderManifestV3; manifestFingerprint: string; renderFingerprint: string };
export function buildRenderManifest(
  timeline: Extract<ProductionTimeline, { schema_version: 'production_timeline_schema_v1' }>,
  metadata: ReadonlyMap<string, MediaAssetMetadata>,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
): { manifest: RenderManifestV1; manifestFingerprint: string; renderFingerprint: string };
export function buildRenderManifest(
  timeline: Extract<ProductionTimeline, { schema_version: 'production_timeline_schema_v2' }>,
  metadata: ReadonlyMap<string, MediaAssetMetadata>,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
): { manifest: RenderManifestV2; manifestFingerprint: string; renderFingerprint: string };
export function buildRenderManifest(
  timeline: ProductionTimeline,
  metadata: ReadonlyMap<string, MediaAssetMetadata>,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
  presentation?: PresentationSpec | null,
  audioMixPlan?: AudioMixPlan | null,
): { manifest: RenderManifest; manifestFingerprint: string; renderFingerprint: string };
export function buildRenderManifest(
  timeline: ProductionTimeline,
  metadata: ReadonlyMap<string, MediaAssetMetadata>,
  profile: RenderProfile,
  mode: 'preview' | 'final',
  config: AppConfig,
  presentation?: PresentationSpec | null,
  audioMixPlan?: AudioMixPlan | null,
): { manifest: RenderManifest; manifestFingerprint: string; renderFingerprint: string } {
  if (audioMixPlan && profile.name !== 'youtube_1080p30_program_audio_v1') {
    throw new ManifestValidationError(
      'invalid_profile',
      'AudioMixPlan requires the Program Audio render profile',
    );
  }
  if (!audioMixPlan && profile.name === 'youtube_1080p30_program_audio_v1') {
    throw new ManifestValidationError(
      'audio_mix_plan_invalid',
      'Program Audio render profile requires AudioMixPlan',
    );
  }
  let parsedAudioMixPlan: AudioMixPlan | null = null;
  if (audioMixPlan) {
    parsedAudioMixPlan = AudioMixPlanSchema.parse(audioMixPlan);
    const { fingerprint: declaredAudioFingerprint, ...audioContent } = parsedAudioMixPlan;
    if (fingerprint(audioContent) !== declaredAudioFingerprint) {
      throw new ManifestValidationError(
        'audio_mix_plan_identity',
        'AudioMixPlan fingerprint does not match its canonical content',
      );
    }
    if (
      parsedAudioMixPlan.narration.sha256 !== timeline.tracks.narration?.audio_sha256 ||
      Math.abs(parsedAudioMixPlan.duration_seconds - timeline.duration_seconds) > 0.001
    ) {
      throw new ManifestValidationError(
        'audio_mix_plan_invalid',
        'AudioMixPlan does not match the ProductionTimeline narration',
      );
    }
  }
  const legacy =
    timeline.schema_version === 'production_timeline_schema_v2'
      ? buildRenderManifestV2(timeline, metadata, profile, mode, config)
      : buildRenderManifestV1(timeline, metadata, profile, mode, config);
  if (!presentation) {
    if (parsedAudioMixPlan) {
      const programManifest = RenderManifestV4Schema.parse({
        ...legacy.manifest,
        schema_version: 'render_manifest_v4',
        composer_strategy_version: 'video_composer_v4_program_audio',
        source_timeline_schema_version: timeline.schema_version,
        presentation: null,
        audio_mix_plan: parsedAudioMixPlan,
      });
      const programManifestFingerprint = fingerprint(programManifest);
      return {
        manifest: programManifest,
        manifestFingerprint: programManifestFingerprint,
        renderFingerprint: fingerprint({
          manifest_fingerprint: programManifestFingerprint,
          composer_strategy_version: 'video_composer_v4_program_audio',
          remotion_version: '4.0.516',
          render_profile_identity: profile.identity,
          mode,
        }),
      };
    }
    return legacy;
  }

  const parsedPresentation = PresentationSpecSchema.parse(presentation);
  const { fingerprint: declaredFingerprint, ...presentationContent } = parsedPresentation;
  if (fingerprint(presentationContent) !== declaredFingerprint) {
    throw new ManifestValidationError(
      'presentation_identity',
      'PresentationSpec fingerprint does not match its canonical content',
    );
  }
  const captionBoundaries = parsedPresentation.captions
    ? parsedPresentation.captions.cues.flatMap((item) => [item.start_seconds, item.end_seconds])
    : [];
  const presentationBoundaries = [
    ...captionBoundaries,
    ...parsedPresentation.section_titles.flatMap((item) => [item.start_seconds, item.end_seconds]),
    ...parsedPresentation.transitions.flatMap((item) => [
      item.boundary_seconds - item.duration_seconds / 2,
      item.boundary_seconds,
      item.boundary_seconds + item.duration_seconds / 2,
    ]),
  ];
  let presentationFrames;
  try {
    const quantized = quantizeBoundaries(
      timeline.duration_seconds,
      presentationBoundaries,
      profile.fps,
    );
    const captionFrames = parsedPresentation.captions
      ? {
          policy_version: parsedPresentation.captions.policy_version,
          preset: parsedPresentation.captions.preset,
          cues: parsedPresentation.captions.cues.map((item) => {
            const start = quantized.frameAt(item.start_seconds);
            const end = quantized.frameAt(item.end_seconds);
            if (end <= start) {
              throw new ManifestValidationError(
                'frame_quantization',
                'Caption cue collapsed to zero frames',
              );
            }
            return {
              text: item.text,
              frame_start: start,
              frame_duration: end - start,
              preset: item.preset,
            };
          }),
        }
      : null;
    presentationFrames = {
      schema_version: parsedPresentation.schema_version,
      strategy_version: parsedPresentation.strategy_version,
      profile_id: parsedPresentation.profile_id,
      fingerprint: parsedPresentation.fingerprint,
      captions: captionFrames,
      section_titles: parsedPresentation.section_titles.map((item) => {
        const start = quantized.frameAt(item.start_seconds);
        const end = quantized.frameAt(item.end_seconds);
        if (end <= start) {
          throw new ManifestValidationError(
            'frame_quantization',
            'Section title collapsed to zero frames',
          );
        }
        return {
          text: item.text,
          frame_start: start,
          frame_duration: end - start,
          preset: item.preset,
        };
      }),
      branding: parsedPresentation.branding,
      transitions: parsedPresentation.transitions.map((item) => {
        const startSeconds = item.boundary_seconds - item.duration_seconds / 2;
        const endSeconds = item.boundary_seconds + item.duration_seconds / 2;
        const start = quantized.frameAt(startSeconds);
        const boundary = quantized.frameAt(item.boundary_seconds);
        const end = quantized.frameAt(endSeconds);
        if (end <= start || boundary <= start || boundary >= end) {
          throw new ManifestValidationError(
            'frame_quantization',
            'Transition collapsed to an invalid frame range',
          );
        }
        return {
          type: item.type,
          frame_start: start,
          boundary_frame: boundary,
          duration_frames: end - start,
          preset: item.preset,
        };
      }),
    };
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    throw new ManifestValidationError('invalid_presentation', 'Presentation range is invalid');
  }

  const manifest = RenderManifestV3Schema.parse({
    ...legacy.manifest,
    schema_version: 'render_manifest_v3',
    composer_strategy_version: 'video_composer_v3_presentation',
    source_timeline_schema_version: timeline.schema_version,
    presentation: presentationFrames,
  });
  if (parsedAudioMixPlan) {
    const programManifest = RenderManifestV4Schema.parse({
      ...manifest,
      schema_version: 'render_manifest_v4',
      composer_strategy_version: 'video_composer_v4_program_audio',
      audio_mix_plan: parsedAudioMixPlan,
    });
    const programManifestFingerprint = fingerprint(programManifest);
    return {
      manifest: programManifest,
      manifestFingerprint: programManifestFingerprint,
      renderFingerprint: fingerprint({
        manifest_fingerprint: programManifestFingerprint,
        composer_strategy_version: 'video_composer_v4_program_audio',
        remotion_version: '4.0.516',
        render_profile_identity: profile.identity,
        mode,
      }),
    };
  }
  const manifestFingerprint = fingerprint(manifest);
  return {
    manifest,
    manifestFingerprint,
    renderFingerprint: fingerprint({
      manifest_fingerprint: manifestFingerprint,
      composer_strategy_version: 'video_composer_v3_presentation',
      remotion_version: '4.0.516',
      render_profile_identity: profile.identity,
      mode,
    }),
  };
}
