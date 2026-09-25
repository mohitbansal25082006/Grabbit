// JobRunner: executes one download end-to-end.
//
//   plan → parallel adaptive fetch (ordered window for segments, positional writes for ranged
//   files) → AES-128 decrypt → OPFS → Mediabunny remux → chrome.downloads
import type { Settings } from '../settings';
import { mergeVtt, vttToSrt } from '../subtitles';
import type { Job } from '../types';
import { hostOf, renderTemplate, sanitizePath, sleep } from '../util';
import { fetchBytes, fetchText, HeaderScope, HttpError, isAbort, RangeIgnoredError, StallError } from './net';
import { planJob, type KeyRef, type Plan, type PlannedPart, type PlannedTrack, type TrackRole } from './planner';
import { AdaptiveConcurrency, backoff } from './scheduler';
import { opfsFile, sniffContainer, type Storage } from './storage';

export interface RunnerHost {
  storage: Storage;
  settings(): Settings;
  update(job: Job, immediate?: boolean): void;
  saveResume(jobId: string, resume: ResumeState | undefined): void;
  save(jobId: string, part: string, url: string, filename: string): Promise<{ downloadId: number; filename?: string }>;
}

export interface ResumeState {
  tracks: Record<string, { parts: number; mode: string; nextWrite?: number; bytesWritten?: number; done?: string }>;
}

interface PartState extends PlannedPart {
  state: 0 | 1 | 2 | 3;
  tries: number;
  notBefore: number;
  got: number;
}

interface TrackState extends Omit<PlannedTrack, 'parts'> {
  file: string;
  parts: PartState[];
  pending: number[];
  doneCount: number;
  nextWrite: number;
  bytesWritten: number;
  buffer: Map<number, Uint8Array>;
  writeChain: Promise<void>;
  firstBytes?: Uint8Array;
  liveStopped?: boolean;
  lastRefresh?: number;
}

const MOSAIC_CELLS = 480;

function describeError(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 403 || e.status === 401) return `Access denied by the server (${e.status}). The link may have expired — reload the page and try again.`;
    if (e.status === 404 || e.status === 410) return `The media is no longer available (${e.status}). Reload the page and try again.`;
    if (e.status === 429) return 'The server is rate-limiting downloads (429). Try again in a moment or lower the connection limit.';
    return `Server error (${e.status}).`;
  }
  if (e instanceof StallError) return 'The connection stalled repeatedly. Check your network and retry.';
  if (e instanceof TypeError) return 'Network error — the server refused the connection.';
  return e instanceof Error ? e.message : String(e);
}

function insertSorted(arr: number[], v: number) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  if (arr[lo] !== v) arr.splice(lo, 0, v);
}

export class JobRunner {
  private ctrl = new AbortController();
  private tracks: TrackState[] = [];
  private plan?: Plan;
  private scope: HeaderScope;
  private conc: AdaptiveConcurrency;
  private keys = new Map<string, Promise<CryptoKey>>();
  private active = 0;
  private finish?: { resolve: () => void; reject: (e: unknown) => void };
  private failed = false;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private tickBytes = 0;
  private lastTick = 0;
  private lastResumeSave = 0;
  private stopReason: 'pause' | 'cancel' | null = null;
  private consecutiveFailures = 0;
  private running?: Promise<void>;

  constructor(
    public job: Job,
    private host: RunnerHost,
    private resume?: ResumeState,
  ) {
    this.scope = new HeaderScope(`job:${job.id}`, job.request.pageUrl, job.request.headers);
    const s = host.settings();
    this.conc = new AdaptiveConcurrency({ min: 2, max: s.maxConnections, initial: Math.min(6, s.maxConnections) });
  }

  get dir() {
    return `jobs/${this.job.id}`;
  }

  setMaxConnections(n: number) {
    this.conc.setMax(n);
  }

  start(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => (this.running = undefined));
    return this.running;
  }

  pause() {
    if (this.job.status === 'recording') return this.stopLive();
    this.stopReason = 'pause';
    this.ctrl.abort(new DOMException('Paused', 'AbortError'));
  }

  async cancel() {
    this.stopReason = 'cancel';
    this.ctrl.abort(new DOMException('Canceled', 'AbortError'));
    await this.running?.catch(() => {});
    this.set({ status: 'canceled', speed: 0, connections: 0, finishedAt: Date.now() }, true);
    await this.host.storage.remove(this.dir).catch(() => {});
    this.host.saveResume(this.job.id, undefined);
  }

  /** Live streams: stop recording and finalize what we have. */
  stopLive() {
    for (const t of this.tracks) if (t.live) t.liveStopped = true;
    this.pump();
  }

  private set(patch: Partial<Job>, immediate = false) {
    Object.assign(this.job, patch);
    this.host.update(this.job, immediate);
  }

  private async run() {
    this.ctrl = new AbortController();
    this.stopReason = null;
    this.failed = false;
    const signal = this.ctrl.signal;
    const req = this.job.request;
    this.set({ status: 'preparing', error: undefined, startedAt: this.job.startedAt ?? Date.now() }, true);
    try {
      if (req.recorded) {
        this.tracks = req.recorded.map((r, i) => this.recordedTrack(r.path, r.role, i));
      } else {
        this.plan = await planJob(req, { scope: this.scope, maxConnections: this.host.settings().maxConnections, signal });
        await this.setupTracks();
        this.set({ status: this.plan.live ? 'recording' : 'downloading', totalParts: this.countParts() }, true);
        await this.downloadAll();
        await Promise.all(this.tracks.map((t) => t.writeChain));
      }
      if (signal.aborted) throw signal.reason;
      this.stopTicker();
      this.set({ status: 'muxing', speed: 0, connections: 0, muxProgress: 0, mosaic: this.mosaic() }, true);
      const outputs = await this.finalize();
      this.set({ status: 'saving', muxProgress: 1 }, true);
      await this.saveOutputs(outputs);
      if (this.plan?.subtitles.length) await this.saveSubtitles().catch((e) => this.set({ warning: `Subtitles skipped: ${describeError(e)}` }));
      this.set({ status: 'done', finishedAt: Date.now(), resumable: false, eta: 0 }, true);
      this.host.saveResume(this.job.id, undefined);
      await this.host.storage.remove(this.dir).catch(() => {});
    } catch (e) {
      this.stopTicker();
      if (this.stopReason === 'pause') {
        this.captureResume();
        this.set({ status: 'paused', speed: 0, connections: 0, resumable: true, mosaic: this.mosaic() }, true);
      } else if (this.stopReason === 'cancel') {
        /* cancel() finalizes state */
      } else {
        this.captureResume();
        this.set({ status: 'error', error: describeError(e), speed: 0, connections: 0, resumable: !req.recorded, finishedAt: Date.now() }, true);
      }
    } finally {
      this.stopTicker();
      clearTimeout(this.wakeTimer);
      await this.host.storage.closeAll(this.dir + '/').catch(() => {});
      void this.scope.dispose();
    }
  }

  private recordedTrack(path: string, role: TrackRole, i: number): TrackState {
    return {
      name: `rec${i}`,
      role,
      mode: 'sequential',
      file: path,
      parts: [],
      pending: [],
      doneCount: 0,
      nextWrite: 0,
      bytesWritten: 0,
      buffer: new Map(),
      writeChain: Promise.resolve(),
    };
  }

  // ───────────── Setup & resume ─────────────

  private async setupTracks() {
    const plan = this.plan!;
    this.tracks = [];
    for (const t of plan.tracks) {
      const file = `${this.dir}/${t.name}.bin`;
      const parts: PartState[] = t.parts.map((p) => ({ ...p, state: 0, tries: 0, notBefore: 0, got: 0 }));
      const ts: TrackState = { ...t, file, parts, pending: [], doneCount: 0, nextWrite: 0, bytesWritten: 0, buffer: new Map(), writeChain: Promise.resolve() };
      const r = this.resume?.tracks[t.name];
      if (r && !t.live && r.parts === parts.length && r.mode === t.mode) {
        if (t.mode === 'sequential') {
          await this.host.storage.open(file, r.bytesWritten ?? 0);
          ts.nextWrite = r.nextWrite ?? 0;
          ts.bytesWritten = r.bytesWritten ?? 0;
          for (let i = 0; i < ts.nextWrite; i++) parts[i].state = 2;
          ts.doneCount = ts.nextWrite;
        } else {
          await this.host.storage.open(file);
          const done = r.done ?? '';
          for (let i = 0; i < parts.length; i++) {
            if (done[i] === '1') {
              parts[i].state = 2;
              ts.doneCount++;
            }
          }
        }
        if (ts.nextWrite > 0 || ts.doneCount > 0) ts.firstBytes = await this.host.storage.head(file, 256).catch(() => undefined);
      } else {
        await this.host.storage.open(file, 0);
      }
      for (let i = 0; i < parts.length; i++) if (parts[i].state !== 2) ts.pending.push(i);
      this.tracks.push(ts);
    }
    this.resume = undefined;
    const alreadyBytes = this.tracks.reduce(
      (a, t) => a + (t.mode === 'sequential' ? t.bytesWritten : t.parts.reduce((b, p) => b + (p.state === 2 ? (p.size ?? 0) : 0), 0)),
      0,
    );
    this.set({
      doneBytes: alreadyBytes,
      doneParts: this.tracks.reduce((a, t) => a + t.doneCount, 0),
      totalBytes: this.estimateTotal(),
    });
  }

  private captureResume() {
    if (!this.tracks.length || this.job.request.recorded) return;
    const tracks: ResumeState['tracks'] = {};
    for (const t of this.tracks) {
      if (t.live) continue;
      tracks[t.name] =
        t.mode === 'sequential'
          ? { parts: t.parts.length, mode: t.mode, nextWrite: t.nextWrite, bytesWritten: t.bytesWritten }
          : { parts: t.parts.length, mode: t.mode, done: t.parts.map((p) => (p.state === 2 ? '1' : '0')).join('') };
    }
    this.resume = { tracks };
    this.host.saveResume(this.job.id, this.resume);
  }

  // ───────────── Download loop ─────────────

  private downloadAll(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.finish = { resolve, reject };
      this.ctrl.signal.addEventListener('abort', () => reject(this.ctrl.signal.reason), { once: true });
      this.lastTick = performance.now();
      this.ticker = setInterval(() => this.tick(), 1000);
      for (const t of this.tracks) if (t.live) void this.pollLive(t);
      this.pump();
    });
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private window() {
    return Math.max(8, this.conc.limit * 3);
  }

  private pickNext(): { t: TrackState; i: number } | null {
    const now = Date.now();
    let best: { t: TrackState; i: number } | null = null;
    let bestRatio = Infinity;
    let soonest = Infinity;
    for (const t of this.tracks) {
      const limit = t.mode === 'sequential' ? t.nextWrite + this.window() : Infinity;
      for (const i of t.pending) {
        if (i >= limit) break;
        const p = t.parts[i];
        if (p.notBefore > now) {
          soonest = Math.min(soonest, p.notBefore);
          continue;
        }
        const ratio = t.parts.length ? t.doneCount / t.parts.length : 1;
        if (ratio < bestRatio) {
          bestRatio = ratio;
          best = { t, i };
        }
        break;
      }
    }
    if (!best && soonest < Infinity) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = setTimeout(() => this.pump(), soonest - now + 5);
    }
    return best;
  }

  private pump() {
    if (this.failed || this.ctrl.signal.aborted || !this.finish) return;
    while (this.active < this.conc.limit) {
      const next = this.pickNext();
      if (!next) break;
      const idx = next.t.pending.indexOf(next.i);
      next.t.pending.splice(idx, 1);
      void this.runPart(next.t, next.i);
    }
    if (this.active === 0 && this.tracks.every((t) => this.trackComplete(t))) {
      const f = this.finish;
      this.finish = undefined;
      Promise.all(this.tracks.map((t) => t.writeChain)).then(() => f.resolve(), f.reject);
    }
  }

  private trackComplete(t: TrackState) {
    if (t.live && !t.liveStopped) return false;
    if (t.pending.length) return false;
    return t.mode === 'sequential' ? t.nextWrite >= t.parts.length : t.doneCount >= t.parts.length;
  }

  private async runPart(t: TrackState, i: number) {
    const p = t.parts[i];
    const signal = this.ctrl.signal;
    p.state = 1;
    p.got = 0;
    this.active++;
    try {
      await this.scope.cover([p.url]);
      const onBytes = (n: number) => {
        p.got += n;
        this.tickBytes += n;
        this.conc.record(n);
        this.job.doneBytes += n;
      };
      if (t.mode === 'positional') {
        const base = p.offset ?? 0;
        await fetchBytes(p.url, {
          signal,
          range: p.range,
          strictRange: !!p.range,
          onBytes,
          stallMs: 25_000,
          sink: async (chunk, off) => {
            if (base + off === 0 && !t.firstBytes) t.firstBytes = chunk.slice(0, 256);
            await this.host.storage.write(t.file, chunk, base + off);
          },
        });
        if (p.size != null && p.range && p.got !== p.size) throw new Error(`Short read (${p.got}/${p.size})`);
        if (p.size == null) t.totalSize = p.got;
      } else {
        const r = await fetchBytes(p.url, { signal, range: p.range, onBytes, stallMs: 20_000 });
        let data = r.data!;
        if (p.key) data = await this.decrypt(data, p.key);
        if (i === 0 || (!t.firstBytes && t.nextWrite === i)) t.firstBytes ??= data.slice(0, 256);
        this.deliver(t, i, data);
      }
      p.state = 2;
      t.doneCount++;
      this.job.doneParts++;
      this.consecutiveFailures = 0;
    } catch (e) {
      this.job.doneBytes -= p.got;
      p.got = 0;
      if (signal.aborted) {
        p.state = 0;
        insertSorted(t.pending, i);
        return;
      }
      if (e instanceof RangeIgnoredError) {
        await this.fallbackToSingleStream(t);
        return;
      }
      await this.handleFailure(t, i, p, e);
    } finally {
      this.active--;
      this.pump();
    }
  }

  private async handleFailure(t: TrackState, i: number, p: PartState, e: unknown) {
    p.tries++;
    this.consecutiveFailures++;
    const retries = this.host.settings().retries;
    if (e instanceof HttpError && (e.status === 429 || e.status === 503)) this.conc.throttle();
    else if (this.consecutiveFailures >= 3) this.conc.throttle();
    if (e instanceof HttpError && [401, 403, 404, 410].includes(e.status) && t.refresh && Date.now() - (t.lastRefresh ?? 0) > 15_000) {
      t.lastRefresh = Date.now();
      try {
        const fresh = await t.refresh();
        if (fresh && fresh.length >= t.parts.length) {
          fresh.forEach((f, k) => {
            if (t.parts[k]) {
              t.parts[k].url = f.url;
              t.parts[k].key = f.key;
            }
          });
          p.tries = Math.max(0, p.tries - 1);
        }
      } catch {
        /* keep original URLs */
      }
    }
    if (p.tries > retries || (e instanceof HttpError && [400, 401, 403, 404, 410].includes(e.status) && p.tries > 2)) {
      this.fail(e);
      return;
    }
    p.state = 3;
    p.notBefore = Date.now() + backoff(p.tries, e instanceof HttpError ? e.retryAfter : undefined);
    insertSorted(t.pending, i);
  }

  private async fallbackToSingleStream(t: TrackState) {
    const url = t.parts[0].url;
    for (const p of t.parts) if (p.state === 1) return; // wait for siblings to settle first
    this.job.doneBytes -= t.parts.reduce((a, p) => a + (p.state === 2 ? (p.size ?? 0) : 0), 0);
    this.job.doneParts -= t.doneCount;
    t.parts = [{ url, offset: 0, size: t.totalSize, state: 0, tries: 0, notBefore: 0, got: 0 }];
    t.pending = [0];
    t.doneCount = 0;
    await this.host.storage.open(t.file, 0);
    this.set({ totalParts: this.countParts() });
  }

  private fail(e: unknown) {
    if (this.failed) return;
    this.failed = true;
    const f = this.finish;
    this.finish = undefined;
    this.ctrl.abort(new DOMException('Failed', 'AbortError'));
    f?.reject(e);
  }

  /** Buffer an out-of-order segment; write contiguous runs to disk in order. */
  private deliver(t: TrackState, i: number, data: Uint8Array) {
    t.buffer.set(i, data);
    t.writeChain = t.writeChain.then(async () => {
      while (t.buffer.has(t.nextWrite)) {
        const d = t.buffer.get(t.nextWrite)!;
        t.buffer.delete(t.nextWrite);
        const len = d.byteLength; // read before the buffer is transferred (detached) to the worker
        await this.host.storage.write(t.file, d, t.bytesWritten);
        t.bytesWritten += len;
        t.nextWrite++;
      }
      this.pump();
    });
    t.writeChain.catch((err) => this.fail(err));
  }

  private decrypt(data: Uint8Array, key: KeyRef): Promise<Uint8Array> {
    let k = this.keys.get(key.uri);
    if (!k) {
      k = (async () => {
        await this.scope.cover([key.uri]);
        const r = await fetchBytes(key.uri, { signal: this.ctrl.signal });
        if (r.data!.byteLength !== 16) throw new Error('Invalid AES-128 key');
        return crypto.subtle.importKey('raw', r.data! as BufferSource, 'AES-CBC', false, ['decrypt']);
      })();
      this.keys.set(key.uri, k);
      k.catch(() => this.keys.delete(key.uri));
    }
    return k.then(async (ck) => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: key.iv as BufferSource }, ck, data as BufferSource)));
  }

  private async pollLive(t: TrackState) {
    const live = t.live!;
    while (!t.liveStopped && !this.ctrl.signal.aborted) {
      await sleep(Math.max(1000, Math.min(10_000, live.targetDuration * 700)), this.ctrl.signal).catch(() => {});
      if (t.liveStopped || this.ctrl.signal.aborted) break;
      try {
        const { text, url } = await fetchText(live.playlistUrl, this.ctrl.signal);
        const { parseHls, seqToIv } = await import('../parsers/hls');
        const pl = parseHls(text, url);
        if (pl.type !== 'media') continue;
        for (const s of pl.segments) {
          if (s.seq <= live.lastSeq) continue;
          live.lastSeq = s.seq;
          const br = s.byteRange;
          const idx = t.parts.push({
            url: s.uri,
            range: br ? [br.offset, br.offset + br.length - 1] : undefined,
            key: s.key?.method === 'AES-128' ? { uri: s.key.uri!, iv: s.key.iv ?? seqToIv(s.seq) } : undefined,
            seq: s.seq,
            duration: s.duration,
            state: 0,
            tries: 0,
            notBefore: 0,
            got: 0,
          });
          t.pending.push(idx - 1);
        }
        if (pl.endList) t.liveStopped = true;
        this.set({ totalParts: this.countParts() });
        this.pump();
      } catch {
        /* transient; keep polling */
      }
    }
    this.pump();
  }

  // ───────────── Progress ─────────────

  private countParts() {
    return this.tracks.reduce((a, t) => a + t.parts.length, 0);
  }

  private estimateTotal(): number | undefined {
    let total = 0;
    let known = true;
    for (const t of this.tracks) {
      if (t.mode === 'positional' && t.totalSize) {
        total += t.totalSize;
        continue;
      }
      const done = t.parts.filter((p) => p.state === 2 && !p.isInit);
      const media = t.parts.filter((p) => !p.isInit).length;
      if (t.mode === 'sequential' && done.length >= 3 && t.bytesWritten > 0) {
        const avg = t.bytesWritten / Math.max(1, t.nextWrite);
        total += avg * t.parts.length;
      } else if (t.mode === 'sequential' && media) {
        known = false;
      } else known = false;
    }
    if (!known || !total) return this.job.request.estimatedSize ?? (total || undefined);
    return Math.round(total);
  }

  private tick() {
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    const sample = (this.tickBytes * 1000) / Math.max(1, dt);
    this.tickBytes = 0;
    const saturated = this.active >= this.conc.limit;
    this.conc.tick(dt, saturated);
    const speed = this.job.speed ? this.job.speed * 0.55 + sample * 0.45 : sample;
    const hist = [...(this.job.speedHistory ?? []), Math.round(sample)].slice(-60);
    const total = this.estimateTotal();
    const remaining = total ? Math.max(0, total - this.job.doneBytes) : undefined;
    this.set({
      speed,
      speedHistory: hist,
      totalBytes: total ? Math.max(total, this.job.doneBytes) : undefined,
      eta: remaining != null && speed > 1 ? remaining / speed : undefined,
      connections: this.active,
      mosaic: this.mosaic(),
      totalParts: this.countParts(),
    });
    if (Date.now() - this.lastResumeSave > 4000) {
      this.lastResumeSave = Date.now();
      this.captureResume();
    }
  }

  private mosaic(): string {
    const states: number[] = [];
    for (const t of this.tracks) for (const p of t.parts) states.push(p.state);
    const n = states.length;
    if (!n) return '';
    const cells = Math.min(n, MOSAIC_CELLS);
    let out = '';
    for (let c = 0; c < cells; c++) {
      const a = Math.floor((c * n) / cells);
      const b = Math.max(a + 1, Math.floor(((c + 1) * n) / cells));
      let active = false;
      let retry = false;
      let done = 0;
      for (let k = a; k < b; k++) {
        const s = states[k];
        if (s === 1) active = true;
        else if (s === 3) retry = true;
        else if (s === 2) done++;
      }
      out += active ? '1' : retry ? '3' : done === b - a ? '2' : done > 0 ? '4' : '0';
    }
    return out;
  }

  // ───────────── Finalize & save ─────────────

  private extFor(t: TrackState, sniffed: string): string {
    if (sniffed === 'ts') return 'ts';
    if (sniffed === 'mp4') return t.role === 'audio' ? 'm4a' : 'mp4';
    if (sniffed === 'webm') return t.role === 'audio' ? 'weba' : 'webm';
    if (sniffed === 'mp3') return 'mp3';
    if (sniffed === 'aac') return 'aac';
    return t.ext || this.plan?.rawExt || 'bin';
  }

  private async finalize(): Promise<{ path: string; ext: string; suffix: string }[]> {
    const req = this.job.request;
    await this.host.storage.closeAll(this.dir + '/');
    const sniffs = await Promise.all(
      this.tracks.map(async (t) => sniffContainer(t.firstBytes ?? (await this.host.storage.head(t.file, 256).catch(() => new Uint8Array())))),
    );
    const single = this.tracks.length === 1;
    const t0 = this.tracks[0];
    const rawExt = t0 ? (req.kind === 'direct' && t0.ext ? t0.ext : this.extFor(t0, sniffs[0])) : 'bin';
    const keepRaw =
      single &&
      !req.audioOnly &&
      !req.recorded &&
      (req.container === 'original' || (req.kind === 'direct' && (req.container === 'auto' || rawExt === req.container)));
    if (keepRaw) return [{ path: t0.file, ext: rawExt, suffix: '' }];
    try {
      const res = await this.host.storage.mux(
        this.tracks.map((t) => ({ path: t.file, role: t.role })),
        `${this.dir}/output`,
        req.container,
        !!req.audioOnly,
        req.title,
        (p) => this.set({ muxProgress: p }),
      );
      this.set({ outputSize: res.size });
      return [{ path: res.path, ext: res.ext, suffix: '' }];
    } catch (e) {
      // Never lose a finished download: save the raw streams instead.
      this.set({ warning: `Saved without merging: ${describeError(e)}` });
      return this.tracks.map((t, i) => ({ path: t.file, ext: this.extFor(t, sniffs[i]), suffix: single ? '' : `.${t.name}` }));
    }
  }

  private baseName(): string {
    const s = this.host.settings();
    const req = this.job.request;
    return renderTemplate(s.filenameTemplate || '{title}', { title: req.title, site: hostOf(req.pageUrl), quality: req.qualityLabel });
  }

  private filePath(suffix: string, ext: string) {
    const s = this.host.settings();
    const folder = s.subfolder ? sanitizePath(s.subfolder) + '/' : '';
    return `${folder}${this.baseName()}${suffix}.${ext}`;
  }

  private async saveOutputs(outputs: { path: string; ext: string; suffix: string }[]) {
    const saved: NonNullable<Job['outputs']> = [];
    for (const o of outputs) {
      const file = await opfsFile(o.path);
      const url = URL.createObjectURL(file);
      const filename = this.filePath(o.suffix, o.ext);
      try {
        const r = await this.host.save(this.job.id, o.path, url, filename);
        saved.push({ name: r.filename ?? filename, downloadId: r.downloadId, size: file.size });
        this.set({ downloadId: r.downloadId, filename: (r.filename ?? filename).split(/[\\/]/).pop()!, savedPath: r.filename, outputs: [...saved] });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  private async saveSubtitles() {
    for (const [idx, s] of (this.plan?.subtitles ?? []).entries()) {
      const texts: string[] = [];
      for (let i = 0; i < s.urls.length; i += 6) {
        const batch = await Promise.all(s.urls.slice(i, i + 6).map((u) => fetchText(u, this.ctrl.signal).then((r) => r.text)));
        texts.push(...batch);
      }
      let body = texts.join('\n');
      let ext = s.format === 'ttml' ? 'ttml' : s.format === 'srt' ? 'srt' : 'vtt';
      if (s.format === 'vtt' || /^\s*WEBVTT/.test(body)) {
        body = vttToSrt(mergeVtt(texts));
        ext = 'srt';
      }
      const blob = new Blob([body], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      try {
        const lang = s.lang ? `.${s.lang}` : `.${idx + 1}`;
        await this.host.save(this.job.id, `sub:${idx}`, url, this.filePath(lang, ext));
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }
}
