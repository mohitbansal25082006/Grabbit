// Network primitives for the engine: streamed fetches with stall detection, typed HTTP errors,
// and per-job DNR header scopes (Referer/Origin replay).
import { bg } from '../messaging';

export class HttpError extends Error {
  constructor(
    public status: number,
    public retryAfter?: number,
  ) {
    super(`HTTP ${status}`);
  }
}

export class RangeIgnoredError extends Error {
  constructor() {
    super('Server ignored the byte-range request');
  }
}

export class StallError extends Error {
  constructor() {
    super('Connection stalled');
  }
}

export interface FetchOptions {
  signal: AbortSignal;
  range?: [number, number];
  /** Throw RangeIgnoredError when a range was requested and the server answered 200. */
  strictRange?: boolean;
  /** Called with every received byte count (for live speed/progress). */
  onBytes?: (n: number) => void;
  /** Stream mode: receive batched chunks with their offset instead of buffering the whole body. */
  sink?: (chunk: Uint8Array, offset: number) => Promise<void>;
  stallMs?: number;
  timeoutMs?: number;
}

export interface FetchResult {
  data?: Uint8Array;
  length: number;
  status: number;
  headers: Headers;
  url: string;
}

const SINK_BATCH = 1 << 20; // 1 MiB writes

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (isFinite(n)) return n * 1000;
  const d = Date.parse(v);
  return isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

export async function fetchBytes(url: string, o: FetchOptions): Promise<FetchResult> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(o.signal.reason);
  if (o.signal.aborted) throw o.signal.reason ?? new DOMException('Aborted', 'AbortError');
  o.signal.addEventListener('abort', onAbort, { once: true });
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      ctrl.abort(new StallError());
    }, o.stallMs ?? 20_000);
  };
  try {
    armStall();
    const headers: Record<string, string> = {};
    if (o.range) headers.Range = `bytes=${o.range[0]}-${o.range[1]}`;
    const res = await fetch(url, { signal: ctrl.signal, headers, credentials: 'include', cache: 'no-store', redirect: 'follow' });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new HttpError(res.status, parseRetryAfter(res.headers.get('retry-after')));
    }
    let sliceFrom = 0;
    let sliceLen = -1;
    if (o.range && res.status === 200) {
      if (o.strictRange) {
        res.body?.cancel().catch(() => {});
        throw new RangeIgnoredError();
      }
      sliceFrom = o.range[0];
      sliceLen = o.range[1] - o.range[0] + 1;
    }
    const len = parseInt(res.headers.get('content-length') || '', 10);
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let preallocated: Uint8Array | undefined =
      !o.sink && isFinite(len) && len > 0 && len < 512 * 1024 * 1024 && sliceLen < 0 ? new Uint8Array(len) : undefined;
    let batch: Uint8Array[] = [];
    let batchBytes = 0;
    let sinkOffset = 0;
    const flushBatch = async () => {
      if (!batchBytes || !o.sink) return;
      const buf = concat(batch, batchBytes);
      batch = [];
      const at = sinkOffset;
      sinkOffset += batchBytes;
      batchBytes = 0;
      await o.sink(buf, at);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStall();
      o.onBytes?.(value.byteLength);
      if (o.sink) {
        batch.push(value);
        batchBytes += value.byteLength;
        if (batchBytes >= SINK_BATCH) await flushBatch();
      } else if (preallocated && received + value.byteLength <= preallocated.byteLength) {
        preallocated.set(value, received);
      } else {
        if (preallocated) {
          chunks.push(preallocated.subarray(0, received));
          preallocated = undefined;
        }
        chunks.push(value);
      }
      received += value.byteLength;
    }
    await flushBatch();
    let data: Uint8Array | undefined;
    if (!o.sink) {
      data = preallocated ? preallocated.subarray(0, received) : concat(chunks, received);
      if (sliceLen >= 0) data = data.subarray(sliceFrom, sliceFrom + sliceLen);
    }
    return { data, length: received, status: res.status, headers: res.headers, url: res.url || url };
  } catch (e) {
    if (stalled) throw new StallError();
    throw e;
  } finally {
    clearTimeout(stallTimer);
    o.signal.removeEventListener('abort', onAbort);
  }
}

export function concat(chunks: Uint8Array[], total?: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total ?? chunks.reduce((a, c) => a + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<{ text: string; url: string }> {
  const r = await fetchBytes(url, { signal: signal ?? new AbortController().signal, stallMs: 20_000 });
  return { text: new TextDecoder().decode(r.data), url: r.url };
}

/** Probe a resource for size + byte-range support using a 1-byte range request. */
export async function probe(url: string, signal?: AbortSignal): Promise<{ size?: number; ranges: boolean; mime?: string; url: string }> {
  const ctrl = new AbortController();
  const link = () => ctrl.abort();
  signal?.addEventListener('abort', link, { once: true });
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', cache: 'no-store', signal: ctrl.signal });
    res.body?.cancel().catch(() => {});
    if (!res.ok) throw new HttpError(res.status);
    const mime = res.headers.get('content-type')?.split(';')[0].trim() || undefined;
    if (res.status === 206) {
      const m = res.headers.get('content-range')?.match(/\/(\d+)/);
      return { size: m ? parseInt(m[1], 10) : undefined, ranges: !!m, mime, url: res.url || url };
    }
    const len = parseInt(res.headers.get('content-length') || '', 10);
    return { size: isFinite(len) ? len : undefined, ranges: false, mime, url: res.url || url };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', link);
  }
}

/** Keeps a DNR rule in the service worker in sync with the CDN hosts a job talks to. */
export class HeaderScope {
  private hosts = new Set<string>();
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(
    readonly id: string,
    private pageUrl: string,
    private headers?: Record<string, string>,
  ) {}

  async cover(urls: string[]) {
    const fresh: string[] = [];
    for (const u of urls) {
      try {
        const h = new URL(u).hostname;
        if (!this.hosts.has(h)) {
          this.hosts.add(h);
          fresh.push(u);
        }
      } catch {
        /* ignore */
      }
    }
    if (fresh.length) {
      this.inflight = this.inflight.then(() =>
        bg('dnr.set', { scope: this.id, urls: fresh, pageUrl: this.pageUrl, headers: this.headers }).catch(() => {}),
      );
    }
    await this.inflight;
  }

  dispose() {
    return bg('dnr.clear', { scope: this.id }).catch(() => {});
  }
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
