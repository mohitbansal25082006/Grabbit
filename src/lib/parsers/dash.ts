// MPEG-DASH MPD parser: SegmentTemplate (+Timeline), SegmentList, SegmentBase and single-file representations.
import { resolveUrl } from '../util';
import { childOf, childrenOf, parseXml, type XmlNode } from './xml';

export interface DashSegmentRef {
  url: string;
  /** Inclusive byte range. */
  range?: [number, number];
  duration?: number;
}

export type DashContentType = 'video' | 'audio' | 'text' | 'image' | 'unknown';

export interface DashRepresentation {
  key: string;
  id: string;
  periodIndex: number;
  contentType: DashContentType;
  mimeType: string;
  codecs?: string;
  bandwidth: number;
  width?: number;
  height?: number;
  frameRate?: number;
  lang?: string;
  label?: string;
  channels?: number;
  isProtected: boolean;
  hdr?: boolean;
  init?: DashSegmentRef;
  segments: DashSegmentRef[];
  /** Representation is a single progressive file (SegmentBase or bare BaseURL). */
  singleFile?: string;
}

export interface DashManifest {
  type: 'static' | 'dynamic';
  duration: number;
  periods: number;
  drm: boolean;
  representations: DashRepresentation[];
}

export const isDashText = (text: string) => /<MPD[\s>]/.test(text.slice(0, 4096));

/** ISO-8601 duration → seconds (e.g. PT1H2M3.5S, P1DT2H). */
export function parseIsoDuration(s?: string): number {
  if (!s) return 0;
  const m = s.match(/^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const [, y, mo, w, d, h, mi, sec] = m.map((x) => (x ? parseFloat(x) : 0));
  return y * 31536000 + mo * 2592000 + w * 604800 + d * 86400 + h * 3600 + mi * 60 + sec;
}

function parseFrameRate(s?: string): number | undefined {
  if (!s) return undefined;
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    return b ? a / b : undefined;
  }
  const v = parseFloat(s);
  return isFinite(v) ? v : undefined;
}

/** Expand `$RepresentationID$`, `$Number%05d$`, `$Time$`, `$Bandwidth$`, `$$`. */
export function expandTemplate(tpl: string, vars: { RepresentationID: string; Number?: number; Time?: number; Bandwidth?: number }): string {
  return tpl.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (m, name: string, width?: string) => {
    if (name === '') return '$';
    const v = (vars as Record<string, string | number | undefined>)[name];
    if (v == null) return m;
    const str = String(v);
    return width ? str.padStart(parseInt(width, 10), '0') : str;
  });
}

function parseRange(s?: string): [number, number] | undefined {
  if (!s) return undefined;
  const [a, b] = s.split('-').map((x) => parseInt(x, 10));
  return isFinite(a) && isFinite(b) ? [a, b] : undefined;
}

function contentTypeOf(mime: string, ct: string | undefined, codecs?: string): DashContentType {
  const t = (ct || mime.split('/')[0] || '').toLowerCase();
  if (t === 'video' || t === 'audio' || t === 'text' || t === 'image') return t;
  if (/vtt|ttml|stpp|wvtt/.test(`${mime} ${codecs ?? ''}`)) return 'text';
  if (mime.startsWith('application/')) return 'text';
  return 'unknown';
}

/** Merge SegmentTemplate/SegmentList/SegmentBase attributes & children across hierarchy levels. */
function mergeSeg(levels: (XmlNode | undefined)[], name: string): XmlNode | undefined {
  let merged: XmlNode | undefined;
  for (const lvl of levels) {
    const node = childOf(lvl, name);
    if (!node) continue;
    if (!merged) merged = { ...node, attrs: { ...node.attrs }, children: [...node.children] };
    else {
      merged.attrs = { ...merged.attrs, ...node.attrs };
      if (node.children.length) {
        // Children like SegmentTimeline / Initialization at lower levels override higher ones.
        const names = new Set(node.children.map((c) => c.local));
        merged.children = [...merged.children.filter((c) => !names.has(c.local)), ...node.children];
      }
    }
  }
  return merged;
}

function baseUrlOf(node: XmlNode | undefined, parentBase: string): string {
  const b = childOf(node, 'BaseURL');
  return b && b.text.trim() ? resolveUrl(b.text.trim(), parentBase) : parentBase;
}

function timelineSegments(tpl: XmlNode, periodDuration: number): { time: number; duration: number; number: number }[] {
  const timescale = parseFloat(tpl.attrs.timescale || '1');
  const startNumber = parseInt(tpl.attrs.startNumber || '1', 10);
  const tl = childOf(tpl, 'SegmentTimeline');
  const out: { time: number; duration: number; number: number }[] = [];
  let num = startNumber;
  if (tl) {
    const S = childrenOf(tl, 'S');
    let t = 0;
    const pto = parseFloat(tpl.attrs.presentationTimeOffset || '0');
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (s.attrs.t != null) t = parseFloat(s.attrs.t);
      const d = parseFloat(s.attrs.d);
      let r = parseInt(s.attrs.r || '0', 10);
      if (r < 0) {
        const nextT = S[i + 1]?.attrs.t != null ? parseFloat(S[i + 1].attrs.t) : pto + periodDuration * timescale;
        r = Math.max(0, Math.ceil((nextT - t) / d) - 1);
      }
      for (let k = 0; k <= r; k++) {
        out.push({ time: t, duration: d / timescale, number: num++ });
        t += d;
      }
    }
    return out;
  }
  const dur = parseFloat(tpl.attrs.duration || '0');
  if (!dur) return out;
  const segDur = dur / timescale;
  const endNumber = tpl.attrs.endNumber ? parseInt(tpl.attrs.endNumber, 10) : undefined;
  const count = endNumber != null ? endNumber - startNumber + 1 : Math.ceil(periodDuration / segDur - 1e-9);
  for (let i = 0; i < count; i++) out.push({ time: i * dur, duration: segDur, number: startNumber + i });
  return out;
}

export function parseDash(text: string, mpdUrl: string): DashManifest {
  const doc = parseXml(text);
  const mpd = doc.children.find((c) => c.local === 'MPD');
  if (!mpd) throw new Error('Not a DASH manifest');
  const type = mpd.attrs.type === 'dynamic' ? 'dynamic' : 'static';
  const mpdDuration = parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const mpdBase = baseUrlOf(mpd, mpdUrl);
  const periods = childrenOf(mpd, 'Period');
  const representations: DashRepresentation[] = [];
  let drm = false;

  // Compute each period's duration.
  const starts = periods.map((p) => parseIsoDuration(p.attrs.start));
  periods.forEach((period, pi) => {
    let pDur = parseIsoDuration(period.attrs.duration);
    if (!pDur) {
      const nextStart = pi + 1 < periods.length ? starts[pi + 1] : mpdDuration;
      pDur = Math.max(0, (nextStart || mpdDuration) - (starts[pi] || 0));
    }
    const pBase = baseUrlOf(period, mpdBase);

    childrenOf(period, 'AdaptationSet').forEach((as, ai) => {
      const asBase = baseUrlOf(as, pBase);
      const asProtected = childrenOf(as, 'ContentProtection').length > 0;
      const roleLabel = childOf(as, 'Label')?.text.trim() || as.attrs.label;
      const essential = [...childrenOf(as, 'EssentialProperty'), ...childrenOf(as, 'SupplementalProperty')];
      const hdrProp = essential.some((e) => /TransferCharacteristics/.test(e.attrs.schemeIdUri || '') && /^(16|18)$/.test(e.attrs.value || ''));
      const asChannels = childOf(as, 'AudioChannelConfiguration')?.attrs.value;

      childrenOf(as, 'Representation').forEach((rep) => {
        const mimeType = rep.attrs.mimeType || as.attrs.mimeType || '';
        const codecs = rep.attrs.codecs || as.attrs.codecs;
        const contentType = contentTypeOf(mimeType, as.attrs.contentType, codecs);
        const isProtected = asProtected || childrenOf(rep, 'ContentProtection').length > 0;
        if (isProtected && contentType !== 'text') drm = true;
        const id = rep.attrs.id || `${pi}-${ai}-${representations.length}`;
        const bandwidth = parseInt(rep.attrs.bandwidth || '0', 10);
        const repBase = baseUrlOf(rep, asBase);
        const levels = [period, as, rep];
        const r: DashRepresentation = {
          key: `${contentType}:${id}`,
          id,
          periodIndex: pi,
          contentType,
          mimeType,
          codecs,
          bandwidth,
          width: rep.attrs.width || as.attrs.width ? parseInt(rep.attrs.width || as.attrs.width, 10) : undefined,
          height: rep.attrs.height || as.attrs.height ? parseInt(rep.attrs.height || as.attrs.height, 10) : undefined,
          frameRate: parseFrameRate(rep.attrs.frameRate || as.attrs.frameRate),
          lang: as.attrs.lang || rep.attrs.lang,
          label: roleLabel,
          channels: parseInt(childOf(rep, 'AudioChannelConfiguration')?.attrs.value || asChannels || '', 10) || undefined,
          isProtected,
          hdr: hdrProp || /^(hev1|hvc1|dvh1|dvhe)\.2/.test(codecs || '') || /^vp09\.02/.test(codecs || ''),
          segments: [],
        };

        const tpl = mergeSeg(levels, 'SegmentTemplate');
        const list = mergeSeg(levels, 'SegmentList');
        const sbase = mergeSeg(levels, 'SegmentBase');
        const vars = { RepresentationID: id, Bandwidth: bandwidth };

        if (tpl && (tpl.attrs.media || childOf(tpl, 'SegmentTimeline'))) {
          const initTpl = tpl.attrs.initialization || childOf(tpl, 'Initialization')?.attrs.sourceURL;
          if (initTpl) r.init = { url: resolveUrl(expandTemplate(initTpl, vars), repBase) };
          for (const s of timelineSegments(tpl, pDur)) {
            r.segments.push({
              url: resolveUrl(expandTemplate(tpl.attrs.media, { ...vars, Number: s.number, Time: s.time }), repBase),
              duration: s.duration,
            });
          }
        } else if (list) {
          const init = childOf(list, 'Initialization');
          if (init) r.init = { url: init.attrs.sourceURL ? resolveUrl(init.attrs.sourceURL, repBase) : repBase, range: parseRange(init.attrs.range) };
          const timescale = parseFloat(list.attrs.timescale || '1');
          const segDur = list.attrs.duration ? parseFloat(list.attrs.duration) / timescale : undefined;
          for (const su of childrenOf(list, 'SegmentURL')) {
            r.segments.push({
              url: su.attrs.media ? resolveUrl(su.attrs.media, repBase) : repBase,
              range: parseRange(su.attrs.mediaRange),
              duration: segDur,
            });
          }
        } else {
          // SegmentBase or bare BaseURL → one progressive file; download it whole with ranged parallel fetches.
          void sbase;
          r.singleFile = repBase;
        }
        representations.push(r);
      });
    });
  });

  return { type, duration: mpdDuration || periods.reduce((a, p) => a + parseIsoDuration(p.attrs.duration), 0), periods: periods.length, drm, representations };
}

/**
 * Stitch a representation choice across all periods. Picks the same id per period when present,
 * otherwise the closest-bandwidth representation of the same content type.
 */
export function stitchPeriods(m: DashManifest, chosen: DashRepresentation): DashRepresentation[] {
  if (m.periods <= 1) return [chosen];
  const out: DashRepresentation[] = [];
  for (let p = 0; p < m.periods; p++) {
    const cands = m.representations.filter((r) => r.periodIndex === p && r.contentType === chosen.contentType && !r.isProtected);
    if (!cands.length) continue;
    const same = cands.find((r) => r.id === chosen.id);
    out.push(same ?? cands.reduce((a, b) => (Math.abs(b.bandwidth - chosen.bandwidth) < Math.abs(a.bandwidth - chosen.bandwidth) ? b : a)));
  }
  return out;
}
