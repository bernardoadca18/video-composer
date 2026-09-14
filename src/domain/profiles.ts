import { fingerprint } from '../core/identity.js';

export interface RenderProfile {
  name: 'youtube_1080p30_v1' | 'youtube_1080p30_program_audio_v1';
  version: 'render_profile_v1' | 'render_profile_program_audio_v1';
  identity: string;
  width: 1920;
  height: 1080;
  fps: 30;
  container: 'mp4';
  videoCodec: 'h264';
  pixelFormat: 'yuv420p';
  crf: 18;
  audioCodec: 'aac';
  audioBitrate: '192k';
  audioSampleRate: 48000;
  audioChannels: 1 | 2;
  fitMode: 'contain';
  backgroundColor: '#000000';
  finalGapPolicy: 'reject';
  previewGapPolicy: 'diagnostic_black';
}

const profileWithoutIdentity = {
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
  audioChannels: 1,
  fitMode: 'contain',
  backgroundColor: '#000000',
  finalGapPolicy: 'reject',
  previewGapPolicy: 'diagnostic_black',
} as const;

export const youtube1080p30V1: RenderProfile = {
  ...profileWithoutIdentity,
  identity: fingerprint(profileWithoutIdentity),
};

const programAudioProfileWithoutIdentity = {
  ...profileWithoutIdentity,
  name: 'youtube_1080p30_program_audio_v1',
  version: 'render_profile_program_audio_v1',
  audioChannels: 2,
} as const;

export const youtube1080p30ProgramAudioV1: RenderProfile = {
  ...programAudioProfileWithoutIdentity,
  identity: fingerprint(programAudioProfileWithoutIdentity),
};

export const renderProfiles = new Map<string, RenderProfile>([
  [youtube1080p30V1.name, youtube1080p30V1],
  [youtube1080p30ProgramAudioV1.name, youtube1080p30ProgramAudioV1],
]);

export class UnknownRenderProfileError extends Error {}

export const resolveRenderProfile = (name: string): RenderProfile => {
  const profile = renderProfiles.get(name);
  if (!profile) throw new UnknownRenderProfileError('unknown_render_profile');
  return profile;
};
