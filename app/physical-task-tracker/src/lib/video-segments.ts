import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const run = promisify(execFile);
export interface VideoSegment { frame: number; file: string; start_s: number; end_s: number }
/** Generate bounded visual previews for sampled intervals, not inferred action boundaries. */
export async function generateSegmentGifs(input: string, directory: string, prefix: string, count: number, duration: number): Promise<VideoSegment[]> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(prefix) || !Number.isInteger(count) || count < 1 || count > 24) throw new Error('Invalid GIF prefix or frame count.');
  await mkdir(directory, { recursive: true });
  const interval = duration > 0 ? duration / count : 2;
  const segments: VideoSegment[] = [];
  for (let frame = 0; frame < count; frame++) {
    const start = frame * interval + (interval - Math.min(interval, 8)) / 2, file = `${prefix}-${frame}.gif`;
    try {
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(start), '-i', input, '-t', String(Math.min(interval, 8)), '-vf', 'fps=8,scale=320:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer', '-loop', '0', '-fs', String(8 * 1024 * 1024), join(directory, file)], { timeout: 60000 });
      segments.push({ frame, file, start_s: start, end_s: start + Math.min(interval, 8) });
    } catch (error) { console.error(`Segment preview ${frame} unavailable: ${(error as Error).message.slice(0, 120)}`); }
  }
  return segments;
}
