/** Builds backend-shaped transcript segments from compact [speaker, text] lines. */
export type Line = readonly [speaker: string | null, text: string];

export type BackendSegment = {
  segment_id: string;
  speaker: string | null;
  raw_speaker: string;
  speaker_reviewed: boolean;
  attribution_source: string | null;
  text: string;
  start_seconds: number;
  end_seconds: number;
  completed: boolean;
};

export type TranscriptOptions = {
  /** Seconds of silence between turns. */
  gap?: number;
  /** Speakers whose turns a teammate has already reviewed. */
  reviewed?: readonly string[];
};

const WORDS_PER_SECOND = 2.6;

export function buildTranscript(key: string, lines: readonly Line[], options: TranscriptOptions = {}): BackendSegment[] {
  const gap = options.gap ?? 1.5;
  const labels = new Map<string, string>();
  let clock = 3;
  return lines.map(([speaker, text], index) => {
    const labelKey = speaker ?? "__unidentified__";
    const raw = labels.get(labelKey) ?? `speaker_${labels.size}`;
    labels.set(labelKey, raw);
    const duration = Math.max(3, Math.round(text.split(/\s+/).length / WORDS_PER_SECOND));
    const start = clock;
    clock = start + duration + gap;
    return {
      segment_id: `${key}:${index + 1}`,
      speaker,
      raw_speaker: raw,
      speaker_reviewed: Boolean(speaker && options.reviewed?.includes(speaker)),
      attribution_source: null,
      text,
      start_seconds: start,
      end_seconds: start + duration,
      completed: true,
    };
  });
}

/** Evidence helper: segment ids by 1-based line number. */
export const evidence = (key: string, ...lines: number[]): string[] => lines.map((line) => `${key}:${line}`);
