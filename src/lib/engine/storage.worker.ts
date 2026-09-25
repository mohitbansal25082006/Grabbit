/// <reference lib="webworker" />
// Storage + mux worker. Owns OPFS SyncAccessHandles (fast random-access disk writes, no
// in-memory buffering of whole files) and runs Mediabunny remuxing off the main thread.
import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  FlacOutputFormat,
  Input,
  MkvOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  StreamTarget,
  type InputAudioTrack,
  type InputVideoTrack,
  type OutputFormat,
  type StreamTargetChunk,
} from 'mediabunny';

type Req =
  | { id: number; op: 'open'; path: string; truncate?: number }
  | { id: number; op: 'write'; path: string; data: ArrayBuffer; at: number }
  | { id: number; op: 'close'; path: string }
  | { id: number; op: 'closeAll'; prefix: string }
  | { id: number; op: 'size'; path: string }
  | { id: number; op: 'remove'; path: string }
  | { id: number; op: 'head'; path: string; length: number }
  | { id: number; op: 'mux'; inputs: MuxInput[]; out: string; container: string; audioOnly: boolean; title?: string };

export interface MuxInput {
  path: string;
  role: 'video' | 'audio' | 'av';
}

export interface MuxResult {
  path: string;
  ext: string;
  size: number;
  mime: string;
}

const handles = new Map<string, FileSystemSyncAccessHandle>();
let rootDir: FileSystemDirectoryHandle | undefined;

async function root() {
  rootDir ??= await navigator.storage.getDirectory();
  return rootDir;
}

async function fileHandle(path: string, create = true): Promise<FileSystemFileHandle> {
  const parts = path.split('/').filter(Boolean);
  let dir = await root();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

async function syncHandle(path: string): Promise<FileSystemSyncAccessHandle> {
  let h = handles.get(path);
  if (!h) {
    h = await (await fileHandle(path)).createSyncAccessHandle();
    handles.set(path, h);
  }
  return h;
}

function closeHandle(path: string) {
  const h = handles.get(path);
  if (h) {
    try {
      h.flush();
      h.close();
    } catch {
      /* already closed */
    }
    handles.delete(path);
  }
}

async function removePath(path: string) {
  for (const k of [...handles.keys()]) if (k === path || k.startsWith(path + '/')) closeHandle(k);
  const parts = path.split('/').filter(Boolean);
  let dir = await root();
  try {
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    await dir.removeEntry(parts[parts.length - 1], { recursive: true });
  } catch {
    /* missing */
  }
}

function post(msg: unknown, transfer: Transferable[] = []) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

// ───────────── Mux ─────────────

const AUDIO_ONLY_FORMATS: Record<string, () => { format: OutputFormat; ext: string }> = {
  aac: () => ({ format: new Mp4OutputFormat({ fastStart: false }), ext: 'm4a' }),
  mp3: () => ({ format: new Mp3OutputFormat(), ext: 'mp3' }),
  opus: () => ({ format: new OggOutputFormat(), ext: 'opus' }),
  vorbis: () => ({ format: new OggOutputFormat(), ext: 'ogg' }),
  flac: () => ({ format: new FlacOutputFormat(), ext: 'flac' }),
};

function pickFormat(container: string, vCodec: string | null, aCodec: string | null, audioOnly: boolean): { format: OutputFormat; ext: string } {
  if (audioOnly && aCodec) {
    const f = AUDIO_ONLY_FORMATS[aCodec]?.();
    if (f && f.format.getSupportedCodecs().includes(aCodec as never)) return f;
    return { format: new MkvOutputFormat(), ext: 'mka' };
  }
  const mp4 = new Mp4OutputFormat({ fastStart: false });
  const supported = mp4.getSupportedCodecs() as string[];
  const mp4Ok = (!vCodec || supported.includes(vCodec)) && (!aCodec || supported.includes(aCodec));
  if (container === 'mkv' || !mp4Ok) return { format: new MkvOutputFormat(), ext: 'mkv' };
  return { format: mp4, ext: 'mp4' };
}

async function mux(req: Extract<Req, { op: 'mux' }>): Promise<MuxResult> {
  for (const i of req.inputs) closeHandle(i.path);
  const inputs = await Promise.all(
    req.inputs.map(async (i) => ({
      role: i.role,
      input: new Input({ source: new BlobSource(await (await fileHandle(i.path, false)).getFile()), formats: ALL_FORMATS }),
    })),
  );
  try {
    let videoTrack: InputVideoTrack | null = null;
    let videoInput: Input | null = null;
    let audioTrack: InputAudioTrack | null = null;
    let audioInput: Input | null = null;
    for (const { role, input } of inputs) {
      if (!req.audioOnly && !videoTrack && role !== 'audio') {
        videoTrack = await input.getPrimaryVideoTrack();
        if (videoTrack) videoInput = input;
      }
    }
    // Prefer a dedicated audio input; fall back to audio muxed into the video stream.
    for (const { role, input } of [...inputs].sort((a, b) => (a.role === 'audio' ? -1 : b.role === 'audio' ? 1 : 0))) {
      if (audioTrack) break;
      if (role === 'video' && inputs.some((x) => x.role === 'audio')) continue;
      audioTrack = await input.getPrimaryAudioTrack();
      if (audioTrack) audioInput = input;
    }
    if (!videoTrack && !audioTrack) throw new Error('No playable tracks found in the downloaded data');

    const vCodec = videoTrack ? await videoTrack.getCodec() : null;
    const aCodec = audioTrack ? await audioTrack.getCodec() : null;
    const { format, ext } = pickFormat(req.container, vCodec, aCodec, req.audioOnly || !videoTrack);
    const outPath = `${req.out}.${ext}`;
    await removePath(outPath);
    const h = await (await fileHandle(outPath)).createSyncAccessHandle();
    let size = 0;
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        h.write(chunk.data, { at: chunk.position });
        size = Math.max(size, chunk.position + chunk.data.byteLength);
      },
    });
    const output = new Output({ format, target: new StreamTarget(writable, { chunked: true }) });
    const tags = req.title ? { title: req.title, comment: 'Grabbed with Grabbit' } : undefined;
    const copy = { mode: 'forced' as const, shiftTolerance: Infinity };
    const progress: number[] = [];
    const report = () => post({ type: 'progress', id: currentMuxId, value: progress.reduce((a, b) => a + b, 0) / progress.length });

    const convs: Conversion[] = [];
    const sameInput = videoInput && audioInput && videoInput === audioInput;
    if (!videoTrack || !audioTrack || sameInput) {
      const input = (videoInput ?? audioInput)!;
      const c = await Conversion.init({
        input,
        output,
        tracks: 'primary',
        video: videoTrack ? {} : { discard: true },
        audio: audioTrack ? {} : { discard: true },
        copy,
        tags: tags ? (t) => ({ ...t, ...tags }) : undefined,
        showWarnings: false,
      });
      convs.push(c);
    } else {
      // Composable conversions don't own the output, so tags are set on it directly.
      if (tags) output.setMetadataTags(tags);
      convs.push(
        await Conversion.init({ input: videoInput!, output, tracks: 'primary', audio: { discard: true }, copy, composable: true, showWarnings: false }),
        await Conversion.init({ input: audioInput!, output, tracks: 'primary', video: { discard: true }, copy, composable: true, showWarnings: false }),
      );
    }
    for (const c of convs) {
      if (!c.isValid) {
        const reasons = c.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
        throw new Error(`Cannot remux (${reasons || 'unsupported'})`);
      }
      const idx = progress.push(0) - 1;
      c.onProgress = (p) => {
        progress[idx] = p;
        report();
      };
    }
    if (convs.length > 1) {
      await output.start();
      await Promise.all(convs.map((c) => c.execute()));
      await output.finalize();
    } else {
      await convs[0].execute();
    }
    h.flush();
    size = h.getSize();
    h.close();
    return { path: outPath, ext, size, mime: await output.getMimeType().catch(() => 'video/mp4') };
  } finally {
    for (const { input } of inputs) input.dispose();
  }
}

let currentMuxId = 0;

// I/O ops are serialized (ordering + handle locking); mux runs concurrently with I/O.
let ioChain: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<Req>) => {
  const req = e.data;
  if (req.op === 'mux') void run(req);
  else ioChain = ioChain.then(() => run(req));
};

async function run(req: Req) {
  try {
    let result: unknown;
    switch (req.op) {
      case 'open': {
        const h = await syncHandle(req.path);
        if (req.truncate != null) h.truncate(req.truncate);
        result = h.getSize();
        break;
      }
      case 'write': {
        const h = await syncHandle(req.path);
        const view = new Uint8Array(req.data);
        let off = 0;
        while (off < view.byteLength) off += h.write(view.subarray(off), { at: req.at + off });
        result = off;
        break;
      }
      case 'close':
        closeHandle(req.path);
        break;
      case 'closeAll':
        for (const k of [...handles.keys()]) if (k.startsWith(req.prefix)) closeHandle(k);
        break;
      case 'size': {
        const h = handles.get(req.path);
        if (h) result = h.getSize();
        else {
          try {
            result = (await (await fileHandle(req.path, false)).getFile()).size;
          } catch {
            result = 0;
          }
        }
        break;
      }
      case 'head': {
        const h = await syncHandle(req.path);
        const buf = new Uint8Array(Math.min(req.length, h.getSize()));
        h.read(buf, { at: 0 });
        result = buf;
        break;
      }
      case 'remove':
        await removePath(req.path);
        break;
      case 'mux':
        currentMuxId = req.id;
        result = await mux(req);
        break;
    }
    post({ type: 'result', id: req.id, ok: true, result });
  } catch (err) {
    post({ type: 'result', id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
