import { fingerprint } from '../core/identity.js';

export interface ProxyProfile {
  profileId: 'render_proxy_1080p30_v2';
  strategyVersion: 'proxy_strategy_v2';
  container: 'mp4';
  codec: 'h264';
  encoderBackend: 'libx264';
  maxWidth: number;
  maxHeight: number;
  scalingPolicy: 'fit_inside_even_dimensions';
  neverUpscale: true;
  fps: number;
  pixelFormat: 'yuv420p';
  qualityMode: 'crf';
  crf: 20;
  preset: 'fast';
  gopFrames: number;
  keyframePolicy: 'fixed_closed_gop';
  scenecut: false;
  colorPolicy: 'bt709_passthrough';
  audioPolicy: 'remove';
  subtitlePolicy: 'remove';
  dataPolicy: 'remove';
  stripMetadata: true;
  movflags: 'faststart';
}

export interface IdentifiedProxyProfile extends ProxyProfile {
  identity: string;
}

export const proxyProfileForRender = (profile: {
  width: number;
  height: number;
  fps: number;
}): IdentifiedProxyProfile => {
  const value: ProxyProfile = {
    profileId: 'render_proxy_1080p30_v2',
    strategyVersion: 'proxy_strategy_v2',
    container: 'mp4',
    codec: 'h264',
    encoderBackend: 'libx264',
    maxWidth: profile.width,
    maxHeight: profile.height,
    scalingPolicy: 'fit_inside_even_dimensions',
    neverUpscale: true,
    fps: profile.fps,
    pixelFormat: 'yuv420p',
    qualityMode: 'crf',
    crf: 20,
    preset: 'fast',
    gopFrames: profile.fps * 2,
    keyframePolicy: 'fixed_closed_gop',
    scenecut: false,
    colorPolicy: 'bt709_passthrough',
    audioPolicy: 'remove',
    subtitlePolicy: 'remove',
    dataPolicy: 'remove',
    stripMetadata: true,
    movflags: 'faststart',
  };
  return { ...value, identity: fingerprint(proxyProfileSpecification(value)) };
};

export const proxyProfileSpecification = (profile: ProxyProfile) => ({
  profile_id: profile.profileId,
  strategy_version: profile.strategyVersion,
  container: profile.container,
  codec: profile.codec,
  encoder_backend: profile.encoderBackend,
  max_width: profile.maxWidth,
  max_height: profile.maxHeight,
  scaling_policy: profile.scalingPolicy,
  never_upscale: profile.neverUpscale,
  fps: profile.fps,
  pixel_format: profile.pixelFormat,
  quality_mode: profile.qualityMode,
  crf: profile.crf,
  preset: profile.preset,
  gop_frames: profile.gopFrames,
  keyframe_policy: profile.keyframePolicy,
  scenecut: profile.scenecut,
  color_policy: profile.colorPolicy,
  audio_policy: profile.audioPolicy,
  subtitle_policy: profile.subtitlePolicy,
  data_policy: profile.dataPolicy,
  strip_metadata: profile.stripMetadata,
  movflags: profile.movflags,
});

export type ProxyProfileSpecification = ReturnType<typeof proxyProfileSpecification>;

export const proxyFingerprint = (
  sourceSha256: string,
  sourceStartMicroseconds: number,
  sourceEndMicroseconds: number,
  profile: IdentifiedProxyProfile,
): string =>
  fingerprint({
    source_sha256: sourceSha256,
    source_start_microseconds: sourceStartMicroseconds,
    source_end_microseconds: sourceEndMicroseconds,
    profile_identity: profile.identity,
    strategy_version: profile.strategyVersion,
  });

export const proxyScaleFilter = (profile: ProxyProfile): string =>
  `scale=w='min(iw,${profile.maxWidth})':h='min(ih,${profile.maxHeight})'` +
  ':force_original_aspect_ratio=decrease:force_divisible_by=2';
