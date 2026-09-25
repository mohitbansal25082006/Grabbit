// WebVTT segment merging + VTT → SRT conversion.

/** Merge segmented WebVTT files into one document (drops repeated headers & duplicate cues). */
export function mergeVtt(parts: string[]): string {
  const cues: string[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const blocks = text.split(/\n{2,}/);
    for (const b of blocks) {
      const block = b.trim();
      if (!block || /^WEBVTT/.test(block) || /^(NOTE|STYLE|REGION)\b/.test(block) || !block.includes('-->')) continue;
      const key = block.replace(/^[^\n]*\n(?=[^\n]*-->)/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      cues.push(block);
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

function vttTimeToSrt(t: string): string {
  const m = t.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return '00:00:00,000';
  const h = (m[1] ?? '0').padStart(2, '0');
  return `${h}:${m[2].padStart(2, '0')}:${m[3]},${m[4].padEnd(3, '0')}`;
}

export function vttToSrt(vtt: string): string {
  const blocks = vtt.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out: string[] = [];
  let n = 1;
  for (const b of blocks) {
    const lines = b.trim().split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [start, rest] = lines[ti].split('-->');
    const end = rest.trim().split(/\s+/)[0];
    const body = lines
      .slice(ti + 1)
      .join('\n')
      .replace(/<(\/?)(i|b|u)>/g, '<$1$2>')
      .replace(/<[^>]+>/g, (tag) => (/^<\/?(i|b|u)>$/.test(tag) ? tag : ''));
    if (!body.trim()) continue;
    out.push(`${n++}\n${vttTimeToSrt(start)} --> ${vttTimeToSrt(end)}\n${body}`);
  }
  return out.join('\n\n') + '\n';
}
