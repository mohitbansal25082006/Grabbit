// JobManager: queue, concurrency across jobs, persistence and progress fan-out.
import { bg, broadcast } from '../messaging';
import { DEFAULT_SETTINGS, type Settings } from '../settings';
import { ACTIVE_STATUSES, type Job, type JobRequest } from '../types';
import { hostOf, renderTemplate, uid } from '../util';
import { idbAll, idbDelete, idbPut } from './idb';
import { JobRunner, type ResumeState, type RunnerHost } from './job';
import { Storage } from './storage';

const RUNNING = new Set(['preparing', 'downloading', 'muxing', 'saving']);

export class JobManager {
  private jobs = new Map<string, Job>();
  private resumes = new Map<string, ResumeState | undefined>();
  private runners = new Map<string, JobRunner>();
  private queue: string[] = [];
  private saveWaiters = new Map<string, { resolve: (v: { filename?: string }) => void; reject: (e: Error) => void }>();
  private lastBroadcast = new Map<string, number>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly storage = new Storage();
  settings: Settings = { ...DEFAULT_SETTINGS };
  private ready: Promise<void>;

  constructor() {
    this.ready = this.load();
  }

  private async load() {
    const stored = await idbAll<Job, ResumeState>().catch(() => []);
    for (const s of stored) {
      const j = s.job;
      if (ACTIVE_STATUSES.includes(j.status)) {
        // The engine restarted mid-download: park it as paused (resumable).
        j.status = j.status === 'queued' ? 'queued' : 'paused';
        j.speed = 0;
        j.connections = 0;
        j.resumable = true;
      }
      this.jobs.set(j.id, j);
      this.resumes.set(j.id, s.resume);
      if (j.status === 'queued') this.queue.push(j.id);
    }
    this.schedule();
  }

  applySettings(s: Settings) {
    this.settings = { ...DEFAULT_SETTINGS, ...s };
    for (const r of this.runners.values()) r.setMaxConnections(this.settings.maxConnections);
    this.schedule();
  }

  private host: RunnerHost = {
    storage: this.storage,
    settings: () => this.settings,
    update: (job, immediate) => this.update(job, immediate),
    saveResume: (id, resume) => {
      this.resumes.set(id, resume);
      this.persist(id, true);
    },
    save: async (jobId, part, url, filename) => {
      const key = `${jobId}|${part}`;
      const done = new Promise<{ filename?: string }>((resolve, reject) => this.saveWaiters.set(key, { resolve, reject }));
      const downloadId = await bg<number>('download.save', { jobId, part, url, filename });
      const r = await done;
      return { downloadId, filename: r.filename };
    },
  };

  /** Called by the service worker when chrome.downloads finished writing a file. */
  onSaved(p: { jobId: string; part: string; ok: boolean; filename?: string; error?: string }) {
    const key = `${p.jobId}|${p.part}`;
    const w = this.saveWaiters.get(key);
    if (!w) return;
    this.saveWaiters.delete(key);
    if (p.ok) w.resolve({ filename: p.filename });
    else w.reject(new Error(p.error === 'USER_CANCELED' ? 'Save was canceled' : `Saving failed (${p.error ?? 'unknown'})`));
  }

  async list(): Promise<Job[]> {
    await this.ready;
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async start(request: JobRequest): Promise<string> {
    await this.ready;
    const id = uid();
    const job: Job = {
      id,
      request,
      status: 'queued',
      createdAt: Date.now(),
      filename: renderTemplate(this.settings.filenameTemplate, { title: request.title, site: hostOf(request.pageUrl), quality: request.qualityLabel }),
      site: hostOf(request.pageUrl),
      doneBytes: 0,
      totalBytes: request.estimatedSize,
      totalParts: 0,
      doneParts: 0,
      speed: 0,
      connections: 0,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.update(job, true);
    this.schedule();
    return id;
  }

  private schedule() {
    const running = [...this.jobs.values()].filter((j) => RUNNING.has(j.status)).length;
    let slots = this.settings.maxJobs - running;
    while (slots > 0 && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      slots--;
      this.run(job);
    }
  }

  private run(job: Job) {
    let r = this.runners.get(job.id);
    if (!r) {
      r = new JobRunner(job, this.host, this.resumes.get(job.id));
      this.runners.set(job.id, r);
    }
    void r.start().finally(() => {
      const j = this.jobs.get(job.id);
      if (j && (j.status === 'done' || j.status === 'error')) {
        bg('job.finished', { job: j }).catch(() => {});
        if (j.status === 'done') {
          this.runners.delete(j.id);
          for (const rec of j.request.recorded ?? []) void this.storage.remove(rec.path.split('/').slice(0, -1).join('/'));
        }
      }
      this.schedule();
    });
  }

  async action(id: string, action: string) {
    await this.ready;
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown download');
    const r = this.runners.get(id);
    switch (action) {
      case 'pause':
        if (job.status === 'queued') {
          this.queue = this.queue.filter((q) => q !== id);
          this.update({ ...job, status: 'paused' }, true);
        } else r?.pause();
        break;
      case 'stop':
        r?.stopLive();
        break;
      case 'resume':
      case 'retry':
        if (job.status === 'paused' || job.status === 'error' || job.status === 'canceled') {
          if (job.status === 'canceled') {
            this.runners.delete(id);
            this.resumes.delete(id);
          }
          Object.assign(job, { status: 'queued', error: undefined, warning: undefined, speed: 0 });
          this.queue.push(id);
          this.update(job, true);
          this.schedule();
        }
        break;
      case 'cancel':
        this.queue = this.queue.filter((q) => q !== id);
        if (r) await r.cancel();
        else {
          Object.assign(job, { status: 'canceled', speed: 0 });
          this.update(job, true);
          await this.storage.remove(`jobs/${id}`).catch(() => {});
        }
        break;
      case 'remove':
        this.queue = this.queue.filter((q) => q !== id);
        if (r && ACTIVE_STATUSES.includes(job.status)) await r.cancel();
        this.runners.delete(id);
        this.jobs.delete(id);
        this.resumes.delete(id);
        await idbDelete(id).catch(() => {});
        await this.storage.remove(`jobs/${id}`).catch(() => {});
        broadcast({ type: 'job-removed', id });
        break;
    }
  }

  async clearFinished() {
    await this.ready;
    for (const j of [...this.jobs.values()]) {
      if (j.status === 'done' || j.status === 'canceled' || j.status === 'error') await this.action(j.id, 'remove');
    }
  }

  private update(job: Job, immediate = false) {
    this.jobs.set(job.id, job);
    const now = Date.now();
    if (immediate || now - (this.lastBroadcast.get(job.id) ?? 0) > 200) {
      this.lastBroadcast.set(job.id, now);
      broadcast({ type: 'job', job: { ...job } });
    }
    this.persist(job.id, immediate);
  }

  private persist(id: string, immediate = false) {
    const write = () => {
      this.persistTimers.delete(id);
      const job = this.jobs.get(id);
      if (!job) return;
      const { speedHistory, mosaic, ...slim } = job;
      void speedHistory;
      void idbPut({ id, job: { ...slim, mosaic: job.status === 'paused' || job.status === 'error' ? mosaic : undefined }, resume: this.resumes.get(id) }).catch(() => {});
    };
    if (immediate) {
      clearTimeout(this.persistTimers.get(id));
      write();
    } else if (!this.persistTimers.has(id)) {
      this.persistTimers.set(id, setTimeout(write, 2000));
    }
  }
}
