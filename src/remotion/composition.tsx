import React from 'react';
import { AbsoluteFill, Audio, Composition, OffthreadVideo, Sequence } from 'remotion';

import { type RenderManifest, RenderManifestSchema } from '../domain/contracts.js';

const GameplayPlacement: React.FC<{
  source: string;
  fit: 'contain';
}> = ({ source, fit }) => (
  <AbsoluteFill style={{ backgroundColor: '#000000' }}>
    <OffthreadVideo muted src={source} style={{ width: '100%', height: '100%', objectFit: fit }} />
  </AbsoluteFill>
);

const PreviewGap: React.FC = () => (
  <AbsoluteFill
    style={{
      alignItems: 'center',
      backgroundColor: '#000000',
      color: '#777777',
      display: 'flex',
      fontFamily: 'sans-serif',
      fontSize: 32,
      justifyContent: 'center',
    }}
  >
    VISUAL GAP
  </AbsoluteFill>
);

export const NarratedGameplayComposition: React.FC<RenderManifest> = (rawProps) => {
  const manifest = RenderManifestSchema.parse(rawProps);
  return (
    <AbsoluteFill style={{ backgroundColor: manifest.render_profile.background_color }}>
      {manifest.placements.map((placement) => (
        <Sequence
          key={placement.id}
          from={placement.frame_start}
          durationInFrames={placement.frame_duration}
          layout="none"
        >
          <GameplayPlacement
            source={placement.source.proxy_url}
            fit={manifest.render_profile.fit_mode}
          />
        </Sequence>
      ))}
      {manifest.mode === 'preview'
        ? manifest.gaps.map((gap) => (
            <Sequence
              key={gap.id}
              from={gap.frame_start}
              durationInFrames={gap.frame_duration}
              layout="none"
            >
              <PreviewGap />
            </Sequence>
          ))
        : null}
      <Audio src={manifest.narration.asset_url} />
    </AbsoluteFill>
  );
};

const placeholder: RenderManifest = {
  schema_version: 'render_manifest_v1',
  composer_strategy_version: 'video_composer_v1',
  proxy_strategy_version: 'clip_proxy_v1',
  workflow_id: '00000000-0000-4000-8000-000000000000',
  production_timeline_id: '00000000-0000-4000-8000-000000000001',
  production_timeline_fingerprint: '0'.repeat(64),
  mode: 'preview',
  duration_seconds: 1,
  duration_in_frames: 30,
  render_profile: {
    name: 'youtube_1080p30_v1',
    identity: '0'.repeat(64),
    width: 1920,
    height: 1080,
    fps: 30,
    fit_mode: 'contain',
    background_color: '#000000',
  },
  narration: {
    sha256: '0'.repeat(64),
    byte_size: null,
    sample_rate: 48000,
    channels: 1,
    asset_key: '0'.repeat(64),
    asset_url: 'http://127.0.0.1/placeholder.wav',
    frame_start: 0,
    frame_duration: 30,
  },
  source_assets: [],
  placements: [],
  gaps: [],
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="NarratedGameplayComposition"
    component={NarratedGameplayComposition}
    durationInFrames={30}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={placeholder}
    calculateMetadata={({ props }) => {
      const manifest = RenderManifestSchema.parse(props);
      return {
        durationInFrames: manifest.duration_in_frames,
        fps: manifest.render_profile.fps,
        width: manifest.render_profile.width,
        height: manifest.render_profile.height,
      };
    }}
  />
);
