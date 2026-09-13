import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';

import { presentationThemeV1 } from './theme.js';

export interface RenderSectionTitle {
  text: string;
  frame_start: number;
  frame_duration: number;
  preset: 'minimal_section_v1';
}

const SectionTitleCard: React.FC<{ title: RenderSectionTitle }> = ({ title }) => {
  const frame = useCurrentFrame();
  const fadeFrames = Math.min(8, Math.max(1, Math.floor(title.frame_duration / 4)));
  const opacity =
    title.frame_duration <= 2
      ? 1
      : Math.max(
          0,
          Math.min(1, frame / fadeFrames, (title.frame_duration - 1 - frame) / fadeFrames),
        );
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-start',
        padding: `116px ${presentationThemeV1.safeHorizontal}px`,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          ...presentationThemeV1.sectionTitle,
          borderLeft: '7px solid #ffffff',
          maxWidth: 1180,
          opacity,
          padding: '12px 0 14px 24px',
        }}
      >
        {title.text}
      </div>
    </AbsoluteFill>
  );
};

export const SectionTitles: React.FC<{ titles: readonly RenderSectionTitle[] }> = ({ titles }) => (
  <>
    {titles.map((title, index) => (
      <Sequence
        key={`${title.frame_start}:${index}`}
        from={title.frame_start}
        durationInFrames={title.frame_duration}
        layout="none"
      >
        <SectionTitleCard title={title} />
      </Sequence>
    ))}
  </>
);
