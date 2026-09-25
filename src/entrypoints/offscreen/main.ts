// Offscreen document: hosts the download engine (long-lived, has DOM + workers + blob URLs).
import { analyze } from '@/lib/engine/analyze';
import { JobManager } from '@/lib/engine/manager';
import { bg, listen } from '@/lib/messaging';
import type { Settings } from '@/lib/settings';
import type { DetectedMedia, JobRequest } from '@/lib/types';

const manager = new JobManager();

listen('offscreen-direct', {
  ping: () => 'pong',
  settings: (s: Settings) => manager.applySettings(s),
  analyze: (p: { media: DetectedMedia }) => analyze(p.media),
  'job.start': (p: { request: JobRequest }) => manager.start(p.request),
  'job.action': (p: { id: string; action: string }) => manager.action(p.id, p.action),
  'jobs.list': () => manager.list(),
  'jobs.clear': () => manager.clearFinished(),
  saved: (p: { jobId: string; part: string; ok: boolean; filename?: string; error?: string }) => manager.onSaved(p),
  'record.finish': (p: {
    title: string;
    pageUrl: string;
    tabId?: number;
    tracks: { path: string; role: 'video' | 'audio' | 'av'; bytes: number }[];
  }) => {
    const request: JobRequest = {
      url: p.pageUrl,
      kind: 'direct',
      pageUrl: p.pageUrl,
      title: p.title || 'Recording',
      container: manager.settings.container === 'original' ? 'auto' : manager.settings.container,
      qualityLabel: 'Recorded',
      recorded: p.tracks.map((t) => ({ path: t.path, role: t.role })),
      estimatedSize: p.tracks.reduce((a, t) => a + t.bytes, 0),
      tabId: p.tabId,
    };
    return manager.start(request);
  },
});

bg<Settings>('settings.get').then((s) => manager.applySettings(s)).catch(() => {});
