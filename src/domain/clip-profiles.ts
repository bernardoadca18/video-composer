import { fingerprint } from '../core/identity.js';

export interface ClipRenderProfile {
  name: 'vertical_short_v1';
  version: 'clip_render_profile_v1';
  identity: string;
  width: 1080;
  height: 1920;
  fps: 30;
  container: 'mp4';
  videoCodec: 'h264';
  pixelFormat: 'yuv420p';
  crf: 18;
  audioCodec: 'aac';
  audioBitrate: '192k';
  audioSampleRate: 48000;
  layoutIntent: 'portrait_blur_background';
}

const clipProfileWithoutIdentity = {
  name: 'vertical_short_v1',
  version: 'clip_render_profile_v1',
  width: 1080,
  height: 1920,
  fps: 30,
  container: 'mp4',
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  crf: 18,
  audioCodec: 'aac',
  audioBitrate: '192k',
  audioSampleRate: 48000,
  layoutIntent: 'portrait_blur_background',
} as const;

export const verticalShortV1: ClipRenderProfile = {
  ...clipProfileWithoutIdentity,
  identity: fingerprint(clipProfileWithoutIdentity),
};

export const clipRenderProfiles = new Map<string, ClipRenderProfile>([
  [verticalShortV1.name, verticalShortV1],
]);

export class UnknownClipRenderProfileError extends Error {}

export { CLIP_PROXY_STRATEGY_V1 } from './clip-manifest.js';

export const resolveClipRenderProfile = (name: string): ClipRenderProfile => {
  const profile = clipRenderProfiles.get(name);
  if (!profile) throw new UnknownClipRenderProfileError('unknown_clip_render_profile');
  return profile;
};
