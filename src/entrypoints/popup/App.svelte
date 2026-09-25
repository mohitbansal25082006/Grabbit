<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Icon from '@/components/Icon.svelte';
  import JobCard from '@/components/JobCard.svelte';
  import Logo from '@/components/Logo.svelte';
  import MediaCard from '@/components/MediaCard.svelte';
  import { createJobs, createSettings, fileAction } from '@/components/stores.svelte';
  import { bg } from '@/lib/messaging';
  import type { PageMeta } from '@/lib/detect/registry';
  import type { DetectedMedia, Job } from '@/lib/types';
  import { hostOf, isHttpUrl } from '@/lib/util';
  import { isActive } from '@/lib/types';

  interface TabInfo {
    url?: string;
    title?: string;
    drm: boolean;
    mse: boolean;
    blocked: boolean;
    meta?: PageMeta;
  }

  const jobs = createJobs();
  const settings = createSettings();
  let tabId = $state<number>(-1);
  let items = $state<DetectedMedia[]>([]);
  let tab = $state<TabInfo>({ drm: false, mse: false, blocked: false });
  let loaded = $state(false);
  let expanded = $state<string | undefined>();
  let recording = $state(false);
  let turbo = $state(false);
  let pasteUrl = $state('');
  let pasteError = $state('');
  let toolsOpen = $state(false);
  let recMsg = $state('');
  let recErr = $state(false);
  let autoOpened = false;
  let timer: ReturnType<typeof setInterval>;

  async function load() {
    if (tabId < 0) return;
    try {
      const r = await bg<{ items: DetectedMedia[]; tab: TabInfo }>('media.list', { tabId });
      // Keep analyzed info we already have if the list is momentarily behind.
      const prev = new Map(items.map((i) => [i.id, i]));
      items = r.items.map((i) => (i.info || !prev.get(i.id)?.info ? i : { ...i, info: prev.get(i.id)!.info }));
      tab = r.tab;
      // Auto-open the first card and the tools panel once; after that the user is in control.
      if (!autoOpened && r.items.length) {
        autoOpened = true;
        expanded = groups.find((g) => !g.item.drm)?.item.id;
      }
      if (!autoOpened && !r.items.length && r.tab.mse && !r.tab.drm) toolsOpen = true;
    } catch {
      /* worker waking up */
    } finally {
      loaded = true;
    }
  }

  onMount(async () => {
    const override = Number(new URLSearchParams(location.search).get('tab'));
    if (override) tabId = override;
    else {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = t?.id ?? -1;
    }
    const rec = await chrome.storage.session.get(`rec:${tabId}`).catch(() => ({}) as Record<string, unknown>);
    recording = !!rec[`rec:${tabId}`];
    const onRec = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[`rec:${tabId}`]) recording = !!changes[`rec:${tabId}`].newValue;
    };
    chrome.storage.onChanged.addListener(onRec);
    await load();
    timer = setInterval(load, 1200);
  });
  onDestroy(() => {
    clearInterval(timer);
    jobs.destroy();
    settings.destroy();
  });

  // Group direct files that are quality variants of the same video.
  const groups = $derived.by(() => {
    const out: { item: DetectedMedia; group: DetectedMedia[] }[] = [];
    const byKey = new Map<string, DetectedMedia[]>();
    for (const it of items) {
      if (it.kind === 'direct' && it.groupKey) {
        const g = byKey.get(it.groupKey);
        if (g) {
          g.push(it);
          continue;
        }
        byKey.set(it.groupKey, [it]);
        out.push({ item: it, group: byKey.get(it.groupKey)! });
      } else out.push({ item: it, group: [it] });
    }
    return out;
  });

  const active = $derived(jobs.list.filter((j) => isActive(j) || j.status === 'paused').slice(0, 3));
  const activeCount = $derived(jobs.list.filter(isActive).length);
  const usable = $derived(groups.filter((g) => !g.item.drm));
  const host = $derived(hostOf(tab.url));

  function onAnalyzed(m: DetectedMedia) {
    items = items.map((i) => (i.id === m.id ? m : i));
  }

  async function jobAction(id: string, action: string) {
    const j = jobs.list.find((x) => x.id === id);
    try {
      if (action === 'open' || action === 'show') await fileAction(j, action);
      else await jobs.action(id, action);
    } catch (e) {
      pasteError = e instanceof Error ? e.message : String(e);
      toolsOpen = true;
    }
  }

  async function toggleRecord() {
    const on = !recording;
    recErr = false;
    recMsg = on ? 'Starting…' : 'Saving…';
    try {
      await bg('record.toggle', { tabId, on, turbo });
      recording = on;
      await chrome.storage.session.set({ [`rec:${tabId}`]: on });
      recMsg = on ? 'Recording — let the video play to the end (or press Stop & save).' : 'Saved! It’s being merged — see Downloads below.';
    } catch (e) {
      recErr = true;
      recMsg = e instanceof Error ? e.message : String(e);
    }
  }

  async function addUrl() {
    pasteError = '';
    const u = pasteUrl.trim();
    if (!isHttpUrl(u)) {
      pasteError = 'Paste a direct media link (MP4, M3U8, MPD…)';
      return;
    }
    try {
      const m = await bg<DetectedMedia | undefined>('media.add', { tabId, url: u });
      pasteUrl = '';
      await load();
      if (m) expanded = m.id;
    } catch (e) {
      pasteError = e instanceof Error ? e.message : String(e);
    }
  }

  const openHub = (hash = '') => bg('hub.open', { hash }).then(() => window.close());
</script>

<div class="atmosphere"></div>
<main class="popup">
  <header>
    <div class="brand">
      <Logo size={34} animated={activeCount > 0} />
      <div>
        <div class="word">Grabbit</div>
        <div class="tag">grab any video, fast</div>
      </div>
    </div>
    <div class="hdr-actions">
      <button class="btn icon ghost dl" onclick={() => openHub('downloads')} title="Downloads" aria-label="Open downloads">
        <Icon name="inbox" size={19} />
        {#if activeCount}<span class="badge mono">{activeCount}</span>{/if}
      </button>
      <button class="btn icon ghost" onclick={() => openHub('settings')} title="Settings" aria-label="Settings"><Icon name="sliders" size={19} /></button>
    </div>
  </header>

  {#if host}
    <div class="site">
      {#if tab.meta?.favicon}<img src={tab.meta.favicon} alt="" width="14" height="14" referrerpolicy="no-referrer" />{:else}<Icon name="globe" size={14} />{/if}
      <span class="ellipsis">{host}</span>
      <span class="spacer"></span>
      {#if usable.length}<span class="chip hot mono">{usable.length} found</span>{/if}
    </div>
  {/if}

  <section class="list">
    {#if tab.blocked}
      <div class="empty">
        <div class="burrow"><Logo size={54} /></div>
        <h3>Not available on YouTube</h3>
        <p>Grabbit doesn’t download from YouTube to respect its Terms of Service and browser store policies. It works on most other sites.</p>
      </div>
    {:else if !loaded}
      {#each [0, 1] as _}<div class="skeleton" style="height:84px;border-radius:20px"></div>{/each}
    {:else if !groups.length}
      <div class="empty">
        <div class="radar"><span></span><span></span><span></span><Logo size={46} animated /></div>
        <h3>{tab.drm ? 'Protected content' : 'Sniffing for videos…'}</h3>
        {#if tab.drm}
          <p>This page plays DRM-protected video. Grabbit respects content protection and can’t download it.</p>
        {:else}
          <p>Press <b>play</b> on the video — Grabbit catches streams the moment they load. Reload the page if it was open before Grabbit was installed.</p>
        {/if}
      </div>
    {:else}
      {#each groups as g (g.item.id)}
        <MediaCard
          item={g.item}
          group={g.group}
          settings={settings.value}
          expanded={expanded === g.item.id}
          jobs={jobs.list}
          ontoggle={() => (expanded = expanded === g.item.id ? undefined : g.item.id)}
          onanalyzed={onAnalyzed}
        />
      {/each}
    {/if}

    {#if !tab.blocked && loaded && tabId >= 0}
      <details class="tools" bind:open={toolsOpen}>
        <summary><Icon name="sparkle" size={14} /> More ways to grab</summary>
        {#if !tab.drm}
          <div class="tool">
            <div class="tool-t">
              <b>Record while playing</b>
              <span class="muted">For players with hidden or obfuscated streams. Captures exactly what plays (non-DRM only).</span>
            </div>
            <div class="tool-row">
              <label class="mini"><input type="checkbox" bind:checked={turbo} disabled={recording} /> Turbo 8×</label>
              <button class="btn sm {recording ? 'rec-on' : ''}" onclick={toggleRecord}>
                <Icon name={recording ? 'stop' : 'record'} size={12} />
                {recording ? 'Stop & save' : 'Start recording'}
              </button>
            </div>
            {#if recMsg}<div class="recmsg" class:bad={recErr}>{recMsg}</div>{/if}
          </div>
        {/if}
        <div class="tool">
          <div class="tool-t"><b>Grab a link</b><span class="muted">Paste a direct MP4 / M3U8 / MPD URL.</span></div>
          <div class="tool-row">
            <input class="input" placeholder="https://…/video.m3u8" bind:value={pasteUrl} onkeydown={(e) => e.key === 'Enter' && addUrl()} />
            <button class="btn sm" onclick={addUrl}><Icon name="plus" size={14} /></button>
          </div>
          {#if pasteError}<div class="perr">{pasteError}</div>{/if}
        </div>
      </details>
    {/if}
  </section>

  {#if active.length}
    <footer>
      <div class="foot-h">
        <span class="label">Downloads</span>
        <button class="link" onclick={() => openHub('downloads')}>Open hub <Icon name="external" size={12} /></button>
      </div>
      {#each active as j (j.id)}
        <JobCard job={j as Job} compact onaction={jobAction} />
      {/each}
    </footer>
  {/if}
</main>

<style>
  :global(body) {
    width: 408px;
    min-height: 220px;
    max-height: 600px;
    overflow-x: hidden;
  }
  .popup {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    max-height: 600px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 14px 10px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .word {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1;
  }
  .tag {
    font-size: 10.5px;
    color: var(--faint);
    letter-spacing: 0.06em;
    margin-top: 3px;
  }
  .hdr-actions {
    display: flex;
    gap: 2px;
  }
  .dl {
    position: relative;
  }
  .badge {
    position: absolute;
    top: 3px;
    right: 2px;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 800;
    display: grid;
    place-items: center;
    padding: 0 4px;
    background: var(--grad);
    color: #fff;
  }
  .site {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 14px 8px;
    padding: 7px 10px;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--stroke);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--muted);
  }
  .site img {
    border-radius: 3px;
  }
  .spacer {
    flex: 1;
  }
  .list > :global(*) {
    flex-shrink: 0;
  }
  .list {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    padding: 2px 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .empty {
    text-align: center;
    padding: 18px 16px 10px;
  }
  .empty h3 {
    margin: 14px 0 6px;
    font-size: 16px;
    letter-spacing: -0.02em;
  }
  .empty p {
    margin: 0;
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.55;
  }
  .radar {
    position: relative;
    width: 120px;
    height: 120px;
    margin: 0 auto;
    display: grid;
    place-items: center;
  }
  .radar span {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, var(--carrot) 55%, transparent);
    animation: ping 2.4s cubic-bezier(0.2, 0.6, 0.4, 1) infinite;
    opacity: 0;
  }
  .radar span:nth-child(2) {
    animation-delay: 0.8s;
  }
  .radar span:nth-child(3) {
    animation-delay: 1.6s;
  }
  @keyframes ping {
    0% {
      transform: scale(0.35);
      opacity: 0.9;
    }
    100% {
      transform: scale(1);
      opacity: 0;
    }
  }
  .burrow {
    display: grid;
    place-items: center;
    padding-top: 6px;
  }
  .tools {
    border-radius: 16px;
    border: 1px dashed var(--stroke-2);
    padding: 0 12px;
  }
  .tools summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 0;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--muted);
  }
  .tools summary::-webkit-details-marker {
    display: none;
  }
  .tools[open] summary {
    color: var(--text);
  }
  .tool {
    padding: 10px 0;
    border-top: 1px solid var(--stroke);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tool-t {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12.5px;
  }
  .tool-t .muted {
    font-size: 11.5px;
  }
  .tool-row {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }
  .tool-row .input {
    height: 30px;
    font-size: 12px;
  }
  .mini {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: var(--muted);
    accent-color: var(--carrot);
  }
  .rec-on {
    color: #fff;
    background: var(--danger);
    border-color: transparent;
    animation: pulse 1.4s infinite;
  }
  @keyframes pulse {
    50% {
      box-shadow: 0 0 0 5px color-mix(in srgb, var(--danger) 25%, transparent);
    }
  }
  .recmsg {
    font-size: 11.5px;
    color: var(--mint);
  }
  .recmsg.bad {
    color: var(--danger);
  }
  .perr {
    font-size: 11.5px;
    color: var(--danger);
  }
  footer {
    border-top: 1px solid var(--stroke);
    padding: 10px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter: blur(10px);
  }
  .foot-h {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .link {
    border: 0;
    background: none;
    color: var(--carrot);
    font-size: 12px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
</style>
