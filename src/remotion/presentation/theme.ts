import type { CSSProperties } from 'react';

export const presentationThemeV1 = {
  safeHorizontal: 112,
  captionBottom: 76,
  captionMaxWidth: 1420,
  caption: {
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 48,
    fontWeight: 700,
    lineHeight: 1.2,
    color: '#ffffff',
    textAlign: 'center',
    whiteSpace: 'pre-line',
    textShadow: '0 2px 4px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 1)',
    backgroundColor: 'rgba(0, 0, 0, 0.52)',
    borderRadius: 12,
    padding: '10px 18px 12px',
  } satisfies CSSProperties,
  sectionTitle: {
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 58,
    fontWeight: 700,
    lineHeight: 1.12,
    color: '#ffffff',
    letterSpacing: '-0.02em',
    textShadow: '0 3px 12px rgba(0, 0, 0, 0.9)',
  } satisfies CSSProperties,
  watermark: {
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 25,
    fontWeight: 700,
    lineHeight: 1,
    color: '#ffffff',
    letterSpacing: '0.04em',
    textShadow: '0 1px 4px rgba(0, 0, 0, 0.9)',
  } satisfies CSSProperties,
} as const;
