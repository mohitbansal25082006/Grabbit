// "Record while playing" sink. Embedded (invisibly) in the page by the content script; receives
// MediaSource append data and streams it to OPFS, then hands the files to the engine to mux.
import { bg } from '@/lib/messaging';

const session = new URLSearchParams(location.search).get('s') || Math.random().toString(36).slice(2);

interface Track {
  sb: number;
  mime: string;
  part: number;
  init?: Uint8Array;
  writable?: FileSystemWritableFileStream;
  chain: Promise<void>;
  parts: { path: string; bytes: number }[];
}

const tracks = new Map<number, Track>();
let dir: FileSystemDirectoryHandle | undefined;

async function recDir() {
  if (dir) return dir;
  const root = await navigator.storage.getDirectory();
  const rec = await root.getDirectoryHandle('rec', { create: true });
  dir = await rec.getDirectoryHandle(session, { create: true });
  return dir;
}

function isInit(b: Uint8Array): boolean {
  if (b.length >= 8) {
    const box = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (box === 'ftyp' || box === 'moov') return true;
  }
  return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function openPart(t: Track) {
  await t.writable?.close().catch(() => {});
  const name = `sb${t.sb}-p${t.part}.bin`;
  const fh = await (await recDir()).getFileHandle(name, { create: true });
  t.writable = await fh.createWritable({ keepExistingData: false });
  t.parts.push({ path: `rec/${session}/${name}`, bytes: 0 });
}

function onData(sb: number, mime: string, data: ArrayBuffer) {
  let t = tracks.get(sb);
  if (!t) {
    t = { sb, mime, part: 0, chain: Promise.resolve(), parts: [] };
    tracks.set(sb, t);
  }
  const track = t;
  const bytes = new Uint8Array(data);
  track.chain = track.chain.then(async () => {
    if (isInit(bytes)) {
      if (track.init && same(track.init, bytes)) return; // repeated init segment
      if (track.init) track.part++; // quality switch → new part
      track.init = bytes;
      await openPart(track);
    } else if (!track.writable) {
      await openPart(track);
    }
    await track.writable!.write(bytes);
    track.parts[track.parts.length - 1].bytes += bytes.byteLength;
  });
}

async function finish(title: string, pageUrl: string) {
  const out: { path: string; role: 'video' | 'audio' | 'av'; bytes: number }[] = [];
  for (const t of tracks.values()) {
    await t.chain.catch(() => {});
    await t.writable?.close().catch(() => {});
    const best = [...t.parts].sort((a, b) => b.bytes - a.bytes)[0];
    if (!best || best.bytes < 1024) continue;
    const m = t.mime.toLowerCase();
    const role = m.startsWith('audio/') ? 'audio' : /mp4a|opus|vorbis|ac-3|ec-3/.test(m) ? 'av' : 'video';
    out.push({ path: best.path, role, bytes: best.bytes });
  }
  if (out.length) await bg('record.finish', { title, pageUrl, tracks: out }).catch((e) => console.warn('[grabbit] record', e));
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const d = e.data as { grabbitRec?: string; sb?: number; mime?: string; data?: ArrayBuffer; title?: string; pageUrl?: string };
  if (d?.grabbitRec === 'data' && d.data && d.sb != null) onData(d.sb, d.mime ?? '', d.data);
  else if (d?.grabbitRec === 'finish') {
    void finish(d.title ?? '', d.pageUrl ?? '').finally(() => window.parent.postMessage({ grabbitRecorder: 'finished' }, '*'));
  }
});

window.parent.postMessage({ grabbitRecorder: 'ready' }, '*');
