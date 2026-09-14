import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Composition,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  useCurrentFrame,
} from 'remotion';

import { type RenderManifest, RenderManifestSchema } from '../domain/contracts.js';
import { PresentationLayers } from './presentation/PresentationLayers.js';

const GameplayPlacement: React.FC<{
  source: string;
  fit: 'contain';
}> = ({ source, fit }) => (
  <AbsoluteFill style={{ backgroundColor: '#000000' }}>
    <OffthreadVideo muted src={source} style={{ width: '100%', height: '100%', objectFit: fit }} />
  </AbsoluteFill>
);

const StaticImagePlacement: React.FC<{
  source: string;
  durationInFrames: number;
  presentation: {
    fit: 'cover' | 'contain';
    background: 'black' | 'blurred_fill';
    motion: 'none' | 'slow_zoom_in' | 'slow_zoom_out';
    zoom_amount: number;
  };
}> = ({ source, durationInFrames, presentation }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scale =
    presentation.motion === 'slow_zoom_in'
      ? 1 + presentation.zoom_amount * progress
      : presentation.motion === 'slow_zoom_out'
        ? 1 + presentation.zoom_amount * (1 - progress)
        : 1;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000000', overflow: 'hidden' }}>
      {presentation.background === 'blurred_fill' ? (
        <Img
          src={source}
          style={{
            filter: 'blur(36px)',
            height: '100%',
            objectFit: 'cover',
            opacity: 0.72,
            transform: 'scale(1.12)',
            width: '100%',
          }}
        />
      ) : null}
      <Img
        src={source}
        style={{
          height: '100%',
          objectFit: presentation.fit,
          position: 'absolute',
          transform: `scale(${scale})`,
          width: '100%',
        }}
      />
    </AbsoluteFill>
  );
};

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
          {'source_type' in placement.source && placement.source.source_type === 'static_image' ? (
            <StaticImagePlacement
              source={placement.source.asset_url}
              durationInFrames={placement.frame_duration}
              presentation={
                'presentation' in placement && placement.presentation
                  ? placement.presentation
                  : {
                      fit: 'contain',
                      background: 'black',
                      motion: 'none',
                      zoom_amount: 0,
                    }
              }
            />
          ) : (
            <GameplayPlacement
              source={placement.source.proxy_url}
              fit={manifest.render_profile.fit_mode}
            />
          )}
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
      {manifest.schema_version === 'render_manifest_v3' ? (
        <PresentationLayers presentation={manifest.presentation} />
      ) : manifest.schema_version === 'render_manifest_v4' && manifest.presentation ? (
        <PresentationLayers presentation={manifest.presentation} />
      ) : null}
      {manifest.schema_version === 'render_manifest_v4' ? null : (
        <Audio src={manifest.narration.asset_url} />
      )}
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
