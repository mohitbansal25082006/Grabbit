// In-page "Grab" pill that appears over videos on hover, with a one-tap quality menu.
// Rendered inside a closed Shadow DOM so site CSS can never break it.
import { bg } from '../messaging';
import { pickVariant } from '../quality';
import type { DetectedMedia } from '../types';
import { formatBytes, formatDuration, qualityLabel } from '../util';

export const RABBIT_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M11.2 2.4c1.9 0 2.9 3 2.9 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6.9-6.6 2.8-6.6Zm9.6 0c1.9 0 2.8 3 2.8 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6 1-6.6 2.9-6.6ZM16 11.4c5 0 9 3.9 9 8.8S21 29.6 16 29.6s-9-4.5-9-9.4 4-8.8 9-8.8Z"/><path fill="none" stroke="var(--g-cut, #0E0B1A)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M16 16.2v7.2m-3.2-3.1 3.2 3.2 3.2-3.2"/></svg>`;

const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:'Space Grotesk Variable','Space Grotesk',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
.pill{position:fixed;z-index:2147483646;display:flex;align-items:center;gap:7px;height:34px;padding:0 12px 0 5px;border-radius:999px;
 background:rgba(14,11,26,.86);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);
 border:1px solid rgba(255,255,255,.14);color:#F4F1FF;font-size:13px;font-weight:600;letter-spacing:.2px;cursor:pointer;
 box-shadow:0 8px 28px -8px rgba(0,0,0,.6),0 0 0 0 rgba(255,107,26,.0);opacity:0;transform:translateY(-6px) scale(.92);
 transition:opacity .18s ease,transform .22s cubic-bezier(.2,1.4,.4,1),box-shadow .2s ease;pointer-events:none;user-select:none}
.pill.show{opacity:1;transform:none;pointer-events:auto}
.pill:hover{box-shadow:0 10px 30px -8px rgba(0,0,0,.7),0 0 0 4px rgba(255,107,26,.25)}
.badge{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#fff;
 background:conic-gradient(from 210deg,#FF6B1A,#FF3D7F,#FFB23D,#FF6B1A);box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)}
.badge svg{width:17px;height:17px;--g-cut:#FF6B1A}
.pill.busy .badge{animation:hop .7s cubic-bezier(.3,1.6,.5,1) infinite}
@keyframes hop{0%,100%{transform:translateY(0)}45%{transform:translateY(-4px) rotate(-6deg)}}
.caret{opacity:.6;font-size:10px}
.panel{position:fixed;z-index:2147483647;width:272px;max-height:360px;overflow:auto;padding:8px;border-radius:18px;
 background:rgba(14,11,26,.94);backdrop-filter:blur(18px) saturate(1.5);-webkit-backdrop-filter:blur(18px) saturate(1.5);
 border:1px solid rgba(255,255,255,.12);color:#F4F1FF;box-shadow:0 24px 60px -12px rgba(0,0,0,.75);
 opacity:0;transform:translateY(-4px) scale(.97);transform-origin:top right;transition:opacity .16s,transform .2s cubic-bezier(.2,1.3,.4,1);pointer-events:none}
.panel.show{opacity:1;transform:none;pointer-events:auto}
.panel::-webkit-scrollbar{width:6px}.panel::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:9px}
.head{padding:6px 8px 8px;font-size:11px;color:#A59FC0;text-transform:uppercase;letter-spacing:1.2px;display:flex;justify-content:space-between}
.row{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border-radius:12px;border:0;background:transparent;color:inherit;cursor:pointer;text-align:left;font-size:13px}
.row:hover,.row:focus-visible{background:rgba(255,107,26,.14);outline:none}
.q{font-weight:700;min-width:62px;font-family:'JetBrains Mono Variable',ui-monospace,monospace;font-size:12.5px}
.meta{flex:1;color:#A59FC0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.go{width:24px;height:24px;border-radius:8px;display:grid;place-items:center;background:rgba(255,255,255,.06);font-size:13px}
.row:hover .go{background:linear-gradient(135deg,#FF6B1A,#FF3D7F)}
.best .q{color:#FFB23D}
.sep{height:1px;background:rgba(255,255,255,.08);margin:6px 4px}
.empty{padding:14px 10px;color:#A59FC0;font-size:12.5px;line-height:1.5}
.lock{color:#FF8FA3}
.skel{height:36px;border-radius:12px;margin:4px 0;background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.1),rgba(255,255,255,.04));background-size:200% 100%;animation:sh 1.1s linear infinite}
@keyframes sh{to{background-position:-200% 0}}
.toast{position:fixed;z-index:2147483647;padding:10px 14px;border-radius:14px;background:rgba(14,11,26,.94);color:#F4F1FF;font-size:13px;font-weight:600;
 border:1px solid rgba(61,255,196,.35);box-shadow:0 12px 30px -10px rgba(0,0,0,.7);opacity:0;transform:translateY(6px);transition:all .25s cubic-bezier(.2,1.3,.4,1);pointer-events:none}
.toast.show{opacity:1;transform:none}
.toast.err{border-color:rgba(255,90,120,.5)}
`;

interface Opt {
  label: string;
  meta: string;
  itemId: string;
  videoId?: string;
  audioOnly?: boolean;
  best?: boolean;
}

export function mountOverlay(): { setEnabled(on: boolean): void } | undefined {
  if (window.innerWidth < 200) return;
  const host = document.createElement('grabbit-overlay');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${CSS}</style>
    <div class="pill" role="button" tabindex="0" aria-label="Download this video with Grabbit"><span class="badge">${RABBIT_SVG}</span><span class="txt">Grab</span><span class="caret">▼</span></div>
    <div class="panel" role="menu"></div><div class="toast" role="status"></div>`;
  const attach = () => document.documentElement.appendChild(host);
  attach();
  // Some SPAs wipe <html> children — re-attach when that happens.
  new MutationObserver(() => {
    if (!host.isConnected) attach();
  }).observe(document.documentElement, { childList: true });

  const pill = root.querySelector('.pill') as HTMLDivElement;
  const txt = root.querySelector('.txt') as HTMLSpanElement;
  const panel = root.querySelector('.panel') as HTMLDivElement;
  const toast = root.querySelector('.toast') as HTMLDivElement;
  let target: HTMLVideoElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let panelOpen = false;
  let rafPending = false;

  const videos = () =>
    [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= 200 && r.height >= 112 && getComputedStyle(v).visibility !== 'hidden';
    });

  const place = () => {
    if (!target) return;
    const r = target.getBoundingClientRect();
    const fs = document.fullscreenElement;
    if (fs && !fs.contains(target)) return;
    const top = Math.max(8, r.top + 12);
    const right = Math.min(window.innerWidth - 8, r.right - 12);
    pill.style.top = `${top}px`;
    pill.style.left = `${right - pill.offsetWidth}px`;
    panel.style.top = `${top + 42}px`;
    panel.style.left = `${Math.max(8, right - 272)}px`;
  };

  const show = (v: HTMLVideoElement) => {
    clearTimeout(hideTimer);
    if (target !== v) {
      target = v;
      closePanel();
    }
    pill.classList.add('show');
    place();
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (panelOpen) return;
      pill.classList.remove('show');
      target = null;
    }, 1600);
  };

  document.addEventListener(
    'pointermove',
    (e) => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (e.composedPath().includes(host)) return clearTimeout(hideTimer);
        const hit = videos().find((v) => {
          const r = v.getBoundingClientRect();
          return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        });
        if (hit) show(hit);
        else scheduleHide();
      });
    },
    { passive: true, capture: true },
  );
  window.addEventListener('scroll', place, { passive: true, capture: true });
  window.addEventListener('resize', place, { passive: true });
  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement;
    (fs ?? document.documentElement).appendChild(host);
  });

  const openPanel = async () => {
    panelOpen = true;
    panel.innerHTML = `<div class="head"><span>Choose quality</span><span>Grabbit</span></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
    panel.classList.add('show');
    place();
    try {
      const opts = await loadOptions(target);
      renderOptions(opts);
    } catch (e) {
      panel.innerHTML = `<div class="empty">${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
    }
  };
  const closePanel = () => {
    panelOpen = false;
    panel.classList.remove('show');
  };

  const renderOptions = (opts: Opt[] | { error: string }) => {
    if (!panelOpen) return;
    if ('error' in opts) {
      panel.innerHTML = `<div class="head"><span>Grabbit</span></div><div class="empty">${escapeHtml(opts.error)}</div>`;
      return;
    }
    const rows = opts
      .map(
        (o, i) =>
          `${o.audioOnly && i > 0 && !opts[i - 1].audioOnly ? '<div class="sep"></div>' : ''}<button class="row${o.best ? ' best' : ''}" data-i="${i}" role="menuitem"><span class="q">${escapeHtml(o.label)}</span><span class="meta">${escapeHtml(o.meta)}</span><span class="go">↓</span></button>`,
      )
      .join('');
    panel.innerHTML = `<div class="head"><span>Choose quality</span><span>${opts.length} options</span></div>${rows}`;
    panel.querySelectorAll('.row').forEach((b) =>
      b.addEventListener('click', () => {
        const o = opts[+(b as HTMLElement).dataset.i!];
        void grab(o);
      }),
    );
  };

  const flash = (msg: string, err = false) => {
    toast.textContent = msg;
    toast.classList.toggle('err', err);
    const r = pill.getBoundingClientRect();
    toast.style.top = `${r.bottom + 10}px`;
    toast.style.left = `${Math.max(8, r.right - 240)}px`;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2600);
  };

  const grab = async (o: Opt) => {
    closePanel();
    pill.classList.add('busy');
    txt.textContent = 'Grabbing…';
    try {
      await bg('quick.grab', { itemId: o.itemId, choice: { videoId: o.videoId, audioOnly: o.audioOnly } });
      flash(`🥕 Grabbing ${o.label}…`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    } finally {
      setTimeout(() => {
        pill.classList.remove('busy');
        txt.textContent = 'Grab';
      }, 900);
    }
  };

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (panelOpen) closePanel();
    else void openPanel();
  });
  pill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pill.click();
    }
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (panelOpen && !e.composedPath().includes(host)) closePanel();
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) closePanel();
  });
  return {
    setEnabled(on: boolean) {
      host.style.display = on ? '' : 'none';
      if (!on) {
        closePanel();
        pill.classList.remove('show');
      }
    },
  };
}

async function loadOptions(video: HTMLVideoElement | null): Promise<Opt[] | { error: string }> {
  const res = await bg<{ items: DetectedMedia[]; tab: { drm: boolean; blocked: boolean } }>('media.list', {});
  if (res.tab.blocked) return { error: 'Grabbit does not download from this site.' };
  let items = res.items.filter((i) => !i.drm);
  if (!items.length) {
    return {
      error: res.tab.drm
        ? '🔒 This video is DRM-protected. Grabbit respects protected content.'
        : 'No downloadable stream found yet. Press play for a moment, then try again — or open Grabbit to record while playing.',
    };
  }
  const src = video?.currentSrc;
  const exact = src && /^https?:/.test(src) ? items.find((i) => i.url === src) : undefined;
  if (exact) {
    const group = exact.groupKey ? items.filter((i) => i.groupKey === exact.groupKey) : [exact];
    items = [...group, ...items.filter((i) => !group.includes(i))];
  }
  const top = items[0];
  const analyzed: DetectedMedia = top.info ? top : ((await bg<DetectedMedia | undefined>('media.analyze', { id: top.id }).catch(() => undefined)) ?? top);
  if (analyzed.drm || analyzed.info?.drm) return { error: '🔒 This video is DRM-protected. Grabbit respects protected content.' };
  const opts: Opt[] = [];
  const info = analyzed.info;
  if (analyzed.kind !== 'direct' && info?.videos.length) {
    const best = pickVariant(info.videos, 'best');
    const byLabel = new Map<string, (typeof info.videos)[number]>();
    for (const v of [...info.videos].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))) {
      if (!byLabel.has(v.label)) byLabel.set(v.label, v);
    }
    for (const v of byLabel.values()) {
      opts.push({
        label: v.label,
        meta: [v.size ? `~${formatBytes(v.size)}` : '', v.codecs?.split(',')[0]?.split('.')[0] ?? ''].filter(Boolean).join(' · '),
        itemId: analyzed.id,
        videoId: v.id,
        best: v.id === best?.id,
      });
    }
    opts.push({ label: 'Audio', meta: 'Audio only', itemId: analyzed.id, audioOnly: true });
  } else {
    const group = (analyzed.groupKey ? items.filter((i) => i.groupKey === analyzed.groupKey) : [analyzed]).map((i) => (i.id === analyzed.id ? analyzed : i));
    const sorted = [...group].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.size ?? 0) - (a.size ?? 0));
    sorted.forEach((i, idx) =>
      opts.push({
        label: i.height ? qualityLabel(i.height, i.info?.videos[0]?.fps, i.info?.videos[0]?.hdr) : (i.mime?.split('/')[1] ?? 'File').toUpperCase(),
        meta: [i.size ? formatBytes(i.size) : '', i.duration ? formatDuration(i.duration) : ''].filter(Boolean).join(' · ') || 'Original file',
        itemId: i.id,
        best: idx === 0,
      }),
    );
    if (!analyzed.audioOnly) opts.push({ label: 'Audio', meta: 'Extract audio', itemId: analyzed.id, audioOnly: true });
  }
  const others = items.filter((i) => i.id !== analyzed.id && i.kind !== 'direct').slice(0, 3);
  for (const o of others) opts.push({ label: o.kind.toUpperCase(), meta: 'Another stream on this page', itemId: o.id });
  return opts;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
