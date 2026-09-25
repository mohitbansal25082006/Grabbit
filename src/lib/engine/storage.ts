// Promise API around the storage/mux worker.
import type { MuxInput, MuxResult } from './storage.worker';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (p: number) => void };

export class Storage {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./storage.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data as { type: string; id: number; ok?: boolean; result?: unknown; error?: string; value?: number };
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') return p.onProgress?.(m.value ?? 0);
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Storage worker crashed'));
      this.pending.clear();
    };
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = [], onProgress?: (p: number) => void): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  open(path: string, truncate?: number) {
    return this.call<number>({ op: 'open', path, truncate });
  }

  /** Write bytes at an absolute offset. The buffer is transferred (zero-copy). */
  write(path: string, data: Uint8Array, at: number) {
    const buf =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer
        ? data.buffer
        : data.slice().buffer;
    return this.call<number>({ op: 'write', path, data: buf, at }, [buf]);
  }

  close(path: string) {
    return this.call<void>({ op: 'close', path });
  }

  closeAll(prefix: string) {
    return this.call<void>({ op: 'closeAll', prefix });
  }

  size(path: string) {
    return this.call<number>({ op: 'size', path });
  }

  head(path: string, length = 16) {
    return this.call<Uint8Array>({ op: 'head', path, length });
  }

  remove(path: string) {
    return this.call<void>({ op: 'remove', path });
  }

  mux(inputs: MuxInput[], out: string, container: string, audioOnly: boolean, title: string | undefined, onProgress?: (p: number) => void) {
    return this.call<MuxResult>({ op: 'mux', inputs, out, container, audioOnly, title }, [], onProgress);
  }
}

/** Resolve a file in OPFS from the main thread (for creating blob URLs to hand to chrome.downloads). */
export async function opfsFile(path: string): Promise<File> {
  const parts = path.split('/').filter(Boolean);
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}

/** Sniff a container from its first bytes. */
export function sniffContainer(b: Uint8Array): 'ts' | 'mp4' | 'webm' | 'mp3' | 'aac' | 'unknown' {
  if (b.length >= 1 && b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return 'ts';
  if (b.length >= 8) {
    const box = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (['ftyp', 'styp', 'moof', 'moov', 'sidx', 'free', 'mdat'].includes(box)) return 'mp4';
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac';
  return 'unknown';
}
