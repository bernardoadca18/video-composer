import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';

export interface RenderTransition {
  type: 'fade_to_black';
  frame_start: number;
  boundary_frame: number;
  duration_frames: number;
  preset: 'section_boundary_fade_v1';
}

const FadeToBlack: React.FC<{
  durationInFrames: number;
  peakFrame: number;
}> = ({ durationInFrames, peakFrame }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, peakFrame, durationInFrames], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <AbsoluteFill style={{ backgroundColor: '#000000', opacity, pointerEvents: 'none' }} />;
};

export const Transitions: React.FC<{ transitions: readonly RenderTransition[] }> = ({
  transitions,
}) => (
  <>
    {transitions.map((transition, index) => {
      return (
        <Sequence
          key={`${transition.boundary_frame}:${index}`}
          from={transition.frame_start}
          durationInFrames={transition.duration_frames}
          layout="none"
        >
          <FadeToBlack
            durationInFrames={transition.duration_frames}
            peakFrame={transition.boundary_frame - transition.frame_start}
          />
        </Sequence>
      );
    })}
  </>
);
