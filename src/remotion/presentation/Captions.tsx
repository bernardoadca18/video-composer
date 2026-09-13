import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';

import { presentationThemeV1 } from './theme.js';

export interface RenderCaptionCue {
  text: string;
  frame_start: number;
  frame_duration: number;
  preset: 'subtle_longform_v1';
}

export const Captions: React.FC<{ cues: readonly RenderCaptionCue[] }> = ({ cues }) => (
  <>
    {cues.map((cue, index) => (
      <Sequence
        key={`${cue.frame_start}:${index}`}
        from={cue.frame_start}
        durationInFrames={cue.frame_duration}
        layout="none"
      >
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: `0 ${presentationThemeV1.safeHorizontal}px ${presentationThemeV1.captionBottom}px`,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              ...presentationThemeV1.caption,
              maxWidth: presentationThemeV1.captionMaxWidth,
            }}
          >
            {cue.text}
          </div>
        </AbsoluteFill>
      </Sequence>
    ))}
  </>
);
