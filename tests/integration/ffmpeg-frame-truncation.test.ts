import { execFileSync } from 'node:child_process';
import { mkdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('FFmpeg Frame Truncation Integration', () => {
  let workDir: string;
  let ffmpegAvailable = false;
  let ffprobeAvailable = false;

  beforeAll(async () => {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      ffmpegAvailable = true;
    } catch {
      ffmpegAvailable = false;
    }
    try {
      execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
      ffprobeAvailable = true;
    } catch {
      ffprobeAvailable = false;
    }

    workDir = path.join(tmpdir(), `frame-truncation-test-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const getFrameCount = (filePath: string): number => {
    const output = execFileSync(
      'ffprobe',
      ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', filePath],
      { encoding: 'utf-8' },
    );
    const count = parseInt(output.trim(), 10);
    if (!Number.isFinite(count)) {
      throw new Error(`Invalid frame count from ffprobe: ${output}`);
    }
    return count;
  };

  const getDuration = (filePath: string): number => {
    const output = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { encoding: 'utf-8' },
    );
    return parseFloat(output.trim());
  };

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)('should generate exactly 31 frames at 30fps', () => {
    const outputPath = path.join(workDir, 'test-31-frames.mp4');

    // Generate test video with exactly 31 frames at 30fps
    // Using lavfi to generate test pattern with exact frame count
    execFileSync(
      'ffmpeg',
      [
        '-f', 'lavfi',
        '-i', 'testsrc=duration=1.033333:size=320x240:rate=30',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-y',
        outputPath,
      ],
      { stdio: 'pipe' },
    );

    const frameCount = getFrameCount(outputPath);
    const duration = getDuration(outputPath);

    // 31 frames at 30fps = 31/30 = 1.033333... seconds
    expect(frameCount).toBe(31);
    expect(duration).toBeCloseTo(31 / 30, 3);
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)('should prove -t flag truncates frames during encode', () => {
    const inputPath = path.join(workDir, 'input-31-frames.mp4');
    const truncatedPath = path.join(workDir, 'truncated-by-t.mp4');

    // Generate 31 frames at 30fps
    execFileSync(
      'ffmpeg',
      [
        '-f', 'lavfi',
        '-i', 'testsrc=duration=1.033333:size=320x240:rate=30',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-y',
        inputPath,
      ],
      { stdio: 'pipe' },
    );

    const originalFrames = getFrameCount(inputPath);
    expect(originalFrames).toBe(31);

    // Now re-encode with -t 1.0 (which should truncate to 30 frames)
    execFileSync(
      'ffmpeg',
      [
        '-i', inputPath,
        '-t', '1.0',  // Truncate to 1.0 seconds
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-y',
        truncatedPath,
      ],
      { stdio: 'pipe' },
    );

    const truncatedFrames = getFrameCount(truncatedPath);

    // -t 1.0 truncates to 30 frames (1.0 * 30 = 30)
    expect(truncatedFrames).toBe(30);
    expect(truncatedFrames).toBeLessThan(originalFrames);
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)('should prove -c:v copy preserves frames without -t', () => {
    const inputPath = path.join(workDir, 'input-copy-test.mp4');
    const copiedPath = path.join(workDir, 'copied-no-t.mp4');

    // Generate 31 frames at 30fps
    execFileSync(
      'ffmpeg',
      [
        '-f', 'lavfi',
        '-i', 'testsrc=duration=1.033333:size=320x240:rate=30',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-y',
        inputPath,
      ],
      { stdio: 'pipe' },
    );

    const originalFrames = getFrameCount(inputPath);
    expect(originalFrames).toBe(31);

    // Copy video stream without -t flag - should preserve all frames
    execFileSync(
      'ffmpeg',
      [
        '-i', inputPath,
        '-c:v', 'copy',
        '-y',
        copiedPath,
      ],
      { stdio: 'pipe' },
    );

    const copiedFrames = getFrameCount(copiedPath);
    expect(copiedFrames).toBe(31);
    expect(copiedFrames).toBe(originalFrames);
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)('should handle audio shorter than video without truncating video', () => {
    const videoPath = path.join(workDir, 'video-31-frames.mp4');
    const audioPath = path.join(workDir, 'audio-short.mp3');
    const muxedPath = path.join(workDir, 'muxed-short-audio.mp4');

    // Generate video with 31 frames at 30fps
    execFileSync(
      'ffmpeg',
      [
        '-f', 'lavfi',
        '-i', 'testsrc=duration=1.033333:size=320x240:rate=30',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-y',
        videoPath,
      ],
      { stdio: 'pipe' },
    );

    // Generate audio shorter than video (0.5 seconds = 15 frames worth)
    execFileSync(
      'ffmpeg',
      [
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=0.5',
        '-c:a', 'aac',
        '-y',
        audioPath,
      ],
      { stdio: 'pipe' },
    );

    const originalVideoFrames = getFrameCount(videoPath);
    expect(originalVideoFrames).toBe(31);

    // Mux with quantized video duration, padding audio
    // Video duration = 31/30 = 1.033333 seconds
    const videoDuration = 31 / 30;

    execFileSync(
      'ffmpeg',
      [
        '-i', videoPath,
        '-i', audioPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-filter_complex', `[1:a]atrim=0:${videoDuration.toFixed(6)},apad=whole_dur=0:${videoDuration.toFixed(6)}[a]`,
        '-map', '[a]',
        '-c:a', 'aac',
        '-y',
        muxedPath,
      ],
      { stdio: 'pipe' },
    );

    const muxedVideoFrames = getFrameCount(muxedPath);
    expect(muxedVideoFrames).toBe(31);
    expect(muxedVideoFrames).toBe(originalVideoFrames);
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)('should handle audio longer than video without truncating video', () => {
    const videoPath = path.join(workDir, 'video-31-frames-long.mp4');
    const audioPath = path.join(workDir, 'audio-long.mp3');
    const muxedPath = path.join(workDir, 'muxed-long-audio.mp4');

    // Generate video with 31 frames at 30fps
    execFileSync(
      'ffmpeg',
      [
        '-f', 'lavfi',
        '-i', 'testsrc=duration=1.033333:size=320x240:rate=30',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-y',
        videoPath,
      ],
      { stdio: 'pipe' },
    );

    // Generate audio longer than video (2.0 seconds)
    execFileSync(
      'ffmpeg',
      [
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=2.0',
        '-c:a', 'aac',
        '-y',
        audioPath,
      ],
      { stdio: 'pipe' },
    );

    const originalVideoFrames = getFrameCount(videoPath);
    expect(originalVideoFrames).toBe(31);

    // Mux with quantized video duration, trimming audio
    const videoDuration = 31 / 30;

    execFileSync(
      'ffmpeg',
      [
        '-i', videoPath,
        '-i', audioPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-filter_complex', `[1:a]atrim=0:${videoDuration.toFixed(6)},apad=whole_dur=0:${videoDuration.toFixed(6)}[a]`,
        '-map', '[a]',
        '-c:a', 'aac',
        '-y',
        muxedPath,
      ],
      { stdio: 'pipe' },
    );

    const muxedVideoFrames = getFrameCount(muxedPath);
    expect(muxedVideoFrames).toBe(31);
    expect(muxedVideoFrames).toBe(originalVideoFrames);
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)('should use nb_read_frames for accurate frame counting', () => {
    const videoPath = path.join(workDir, 'frame-count-test.mp4');

    // Generate video with exactly 31 frames
    execFileSync(
      'ffmpeg',
      [
        '-f', 'lavfi',
        '-i', 'testsrc=duration=1.033333:size=320x240:rate=30',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-y',
        videoPath,
      ],
      { stdio: 'pipe' },
    );

    // Count frames using -count_frames (nb_read_frames)
    const output = execFileSync(
      'ffprobe',
      ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', videoPath],
      { encoding: 'utf-8' },
    );

    const result = JSON.parse(output);
    const nbReadFrames = parseInt(result.streams[0].nb_read_frames, 10);

    expect(nbReadFrames).toBe(31);
  });
});
