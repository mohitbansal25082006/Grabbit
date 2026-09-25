<script lang="ts">
  import { untrack } from 'svelte';
  import { bg } from '@/lib/messaging';
  import { pickAudio, pickVariant, videoCodecFamily } from '@/lib/quality';
  import { buildRequest, describeItem, titleFor } from '@/lib/request';
  import { presetForHost, type Settings } from '@/lib/settings';
  import type { DetectedMedia, Job, OutputContainer } from '@/lib/types';
  import { formatBytes, formatDuration, hostOf, qualityLabel } from '@/lib/util';
  import Hopper from './Hopper.svelte';
  import Icon from './Icon.svelte';
  import QualityDial, { type DialOption } from './QualityDial.svelte';

  let {
    item,
    group = [item],
    settings,
    expanded = false,
    jobs = [],
    ontoggle,
    onanalyzed,
  }: {
    item: DetectedMedia;
    group?: DetectedMedia[];
    settings: Settings;
    expanded?: boolean;
    jobs?: Job[];
    ontoggle: () => void;
    onanalyzed: (m: DetectedMedia) => void;
  } = $props();

  let busy = $state(false);
  let error = $state('');
  let jobId = $state<string | undefined>();
  let selected = $state<string | undefined>();
  let audioId = $state<string | undefined>();
  let subId = $state<string>('');
  let container = $state<OutputContainer>('auto');
  let audioOnly = $state(false);
  let title = $state('');
  let analyzing = $state(false);

  const info = $derived(item.info);
  const isDirect = $derived(item.kind === 'direct');
  const preset = $derived(presetForHost(settings, hostOf(item.pageUrl)));

  // Initialise user-editable fields once (and again only when settings really change) —
  // the popup refreshes `item` every second and must never wipe what the user typed or picked.
  let appliedSettings: Settings | undefined;
  let titledFor = '';
  $effect(() => {
    const s = settings;
    if (s === appliedSettings) return;
    appliedSettings = s;
    untrack(() => {
      container = s.container;
      audioOnly = presetForHost(s, hostOf(item.pageUrl)) === 'audio' || !!item.audioOnly;
    });
  });
  $effect(() => {
    const id = item.id;
    if (id === titledFor) return;
    titledFor = id;
    title = untrack(() => titleFor(item));
  });

  // Analyze lazily when expanded.
  $effect(() => {
    if (expanded && !item.info && !item.analyzing && !analyzing && !item.error) {
      analyzing = true;
      bg<DetectedMedia>('media.analyze', { tabId: item.tabId, id: item.id })
        .then((m) => m && onanalyzed(m))
        .catch((e) => (error = e instanceof Error ? e.message : String(e)))
        .finally(() => (analyzing = false));
    }
  });

  const variants = $derived.by<DialOption[]>(() => {
    if (isDirect) {
      return [...group]
        .sort((a, b) => (a.height ?? 0) - (b.height ?? 0) || (a.size ?? 0) - (b.size ?? 0))
        .map((g) => {
          const v = g.info?.videos[0];
          const h = v?.height ?? g.height;
          return {
            id: g.id,
            label: h ? qualityLabel(h, v?.fps, v?.hdr) : (g.mime?.split('/')[1] ?? 'File').toUpperCase(),
            sub: v?.codecs ? videoCodecFamily(v.codecs).toUpperCase() : undefined,
            size: g.size ? formatBytes(g.size) : undefined,
          };
        });
    }
    if (!info?.videos.length) return [];
    // One stop per label, preferring the codec the user wants.
    const byLabel = new Map<string, typeof info.videos>();
    for (const v of info.videos) byLabel.set(v.label, [...(byLabel.get(v.label) ?? []), v]);
    const picked = [...byLabel.values()].map((vs) => pickVariant(vs, 'best', settings.codec)!);
    return picked
      .sort((a, b) => (a.height ?? 0) - (b.height ?? 0) || (a.bandwidth ?? 0) - (b.bandwidth ?? 0))
      .map((v) => {
        const fam = videoCodecFamily(v.codecs);
        const audio = v.hasAudio === false ? pickAudio(info.audios, v.audioGroup) : undefined;
        const total = v.size ? v.size + (audio?.size ?? 0) : undefined;
        return {
          id: v.id,
          label: v.label,
          sub: [fam !== 'unknown' && fam !== 'other' ? fam.toUpperCase() : '', v.fps && v.fps > 32 ? `${Math.round(v.fps)}fps` : '', v.hdr ? 'HDR' : '']
            .filter(Boolean)
            .join(' · '),
          size: total ? `~${formatBytes(total)}` : undefined,
        };
      });
  });

  // Default selection per preset.
  $effect(() => {
    if (selected && variants.some((v) => v.id === selected)) return;
    if (isDirect) {
      selected = [...group].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.size ?? 0) - (a.size ?? 0))[0]?.id;
    } else if (info?.videos.length) {
      const v = pickVariant(info.videos, preset === 'audio' ? 'best' : preset, settings.codec);
      selected = variants.find((o) => o.id === v?.id)?.id ?? variants[variants.length - 1]?.id;
    }
  });

  const chosenVideo = $derived(!isDirect ? info?.videos.find((v) => v.id === selected) : undefined);
  const audios = $derived(info?.audios ?? []);
  $effect(() => {
    if (!audioId && audios.length) audioId = pickAudio(audios, chosenVideo?.audioGroup)?.id;
  });

  const targetItem = $derived(isDirect ? (group.find((g) => g.id === selected) ?? item) : item);
  const current = $derived(variants.find((v) => v.id === selected));
  const estimate = $derived.by(() => {
    if (isDirect) return targetItem.size;
    if (audioOnly) return audios.find((a) => a.id === audioId)?.size;
    const v = chosenVideo;
    if (!v?.size) return undefined;
    return v.size + (v.hasAudio === false ? (audios.find((a) => a.id === audioId)?.size ?? 0) : 0);
  });

  const job = $derived(jobId ? jobs.find((j) => j.id === jobId) : undefined);
  const jobProgress = $derived(job ? (job.status === 'done' ? 1 : job.totalBytes ? job.doneBytes / job.totalBytes : job.totalParts ? job.doneParts / job.totalParts : 0) : 0);
  const blocked = $derived(!!item.drm || !!info?.drm);
  const waiting = $derived(!isDirect && !info && (analyzing || item.analyzing));

  async function grab() {
    error = '';
    busy = true;
    try {
      const req = buildRequest(targetItem, settings, {
        videoId: isDirect ? undefined : selected,
        audioId: audioId,
        audioOnly,
        container,
        subtitleIds: subId ? [subId] : [],
        title: title.trim() || undefined,
      });
      jobId = await bg<string>('job.start', { request: req });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const kindChip = $derived(item.kind === 'direct' ? (item.audioOnly ? 'AUDIO' : (item.mime?.split('/')[1] ?? 'FILE').toUpperCase().slice(0, 5)) : item.kind.toUpperCase());
</script>

<article class="card" class:expanded class:blocked>
  <button class="head" onclick={ontoggle} aria-expanded={expanded}>
    <div class="thumb">
      {#if item.thumbnail}
        <img src={item.thumbnail} alt="" loading="lazy" referrerpolicy="no-referrer" />
      {:else}
        <div class="ph"><Icon name={item.audioOnly ? 'music' : 'film'} size={22} /></div>
      {/if}
      {#if item.duration}<span class="dur mono">{formatDuration(item.duration)}</span>{/if}
      {#if item.live}<span class="live">LIVE</span>{/if}
    </div>
    <div class="info">
      <div class="chips">
        <span class="chip {item.kind === 'direct' ? 'violet' : 'hot'}">{kindChip}</span>
        {#if blocked}<span class="chip danger"><Icon name="lock" size={11} /> DRM</span>{/if}
        {#if group.length > 1}<span class="chip">{group.length} sizes</span>{/if}
      </div>
      <div class="title">{titleFor(item)}</div>
      <div class="desc ellipsis">
        {#if item.analyzing || analyzing}<span class="sniff">Reading stream…</span>{:else}{describeItem(item)}{/if}
      </div>
    </div>
    <span class="chev" class:open={expanded}><Icon name="chevron" size={16} /></span>
  </button>

  {#if expanded}
    <div class="panel">
      {#if blocked}
        <div class="notice danger">
          <Icon name="lock" size={16} />
          <div>This video is protected with DRM. Grabbit respects content protection and can’t download it.</div>
        </div>
      {:else if waiting}
        <div class="loading">
          <div class="skeleton" style="width:170px;height:170px;border-radius:50%;margin:6px auto"></div>
          <div class="skeleton" style="height:40px;margin-top:12px"></div>
        </div>
      {:else}
        {#if item.error && !info && !isDirect}
          <div class="notice warn"><Icon name="info" size={16} /><div>Couldn’t read the manifest ({item.error}). You can still try to grab it.</div></div>
        {/if}

        {#if variants.length > 1 && !audioOnly}
          <QualityDial options={variants} bind:value={selected} size={176} />
        {:else if current && !audioOnly}
          <div class="single">
            <span class="big">{current.label}</span>
            {#if current.sub}<span class="muted">{current.sub}</span>{/if}
            {#if current.size}<span class="mono size">{current.size}</span>{/if}
          </div>
        {/if}

        <div class="controls">
          <div class="row">
            <label class="toggle" title="Download the audio track only">
              <input type="checkbox" bind:checked={audioOnly} />
              <span class="sw"></span>
              <Icon name="music" size={14} /> Audio only
            </label>
            <div class="seg" role="radiogroup" aria-label="Output format">
              {#each [['auto', 'Auto'], ['mp4', 'MP4'], ['mkv', 'MKV'], ['original', 'Raw']] as [v, l]}
                <button role="radio" aria-checked={container === v} class:on={container === v} onclick={() => (container = v as OutputContainer)}>{l}</button>
              {/each}
            </div>
          </div>

          {#if audios.length > 1}
            <label class="field">
              <span class="label">Audio track</span>
              <select class="input" bind:value={audioId}>
                {#each audios as a}
                  <option value={a.id}>{a.name || a.lang || a.id}{a.channels && a.channels > 2 ? ` · ${a.channels}ch` : ''}</option>
                {/each}
              </select>
            </label>
          {/if}

          {#if info?.subtitles.length}
            <label class="field">
              <span class="label">Subtitles (saved as .srt)</span>
              <select class="input" bind:value={subId}>
                <option value="">None</option>
                {#each info.subtitles as s}<option value={s.id}>{s.name || s.lang}</option>{/each}
              </select>
            </label>
          {/if}

          <label class="field">
            <span class="label">File name</span>
            <input class="input" bind:value={title} spellcheck="false" />
          </label>
        </div>

        {#if job}
          <div class="progress">
            <Hopper value={jobProgress} state={job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : job.status === 'muxing' ? 'muxing' : 'active'} indeterminate={job.status === 'preparing' || job.status === 'recording'} />
            <div class="pmeta mono">
              <span>{job.status === 'done' ? 'Saved ✓' : job.status === 'error' ? job.error : job.status === 'muxing' ? 'Merging…' : job.status === 'preparing' ? 'Preparing…' : `${Math.round(jobProgress * 100)}%`}</span>
              {#if job.speed && job.status === 'downloading'}<span class="spd">{formatBytes(job.speed)}/s · {job.connections} lanes</span>{/if}
            </div>
          </div>
        {/if}

        <button class="grab" onclick={grab} disabled={busy}>
          <span class="bunny" class:go={busy}><Icon name="download" size={18} stroke={2.4} /></span>
          <span>{busy ? 'Starting…' : job ? 'Grab again' : `Grab ${audioOnly ? 'audio' : (current?.label ?? 'video')}`}</span>
          {#if estimate && !busy}<span class="est mono">~{formatBytes(estimate)}</span>{/if}
        </button>
        {#if error}<div class="notice danger small">{error}</div>{/if}
      {/if}
    </div>
  {/if}
</article>

<style>
  .card {
    flex-shrink: 0;
    border-radius: 20px;
    background: var(--surface);
    border: 1px solid var(--stroke);
    overflow: hidden;
    transition:
      border-color 0.2s,
      background 0.2s,
      box-shadow 0.2s;
    animation: pop-in 0.3s cubic-bezier(0.2, 1.2, 0.4, 1) both;
  }
  .card:hover {
    border-color: var(--stroke-2);
  }
  .card.expanded {
    background: var(--surface-2);
    border-color: color-mix(in srgb, var(--carrot) 35%, var(--stroke));
    box-shadow: var(--shadow);
  }
  .head {
    display: grid;
    grid-template-columns: 96px 1fr auto;
    gap: 12px;
    align-items: center;
    width: 100%;
    padding: 10px;
    border: 0;
    background: none;
    text-align: left;
  }
  .thumb {
    position: relative;
    aspect-ratio: 16/10;
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-3);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .ph {
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--faint);
    background: var(--grad-soft);
  }
  .dur,
  .live {
    position: absolute;
    right: 5px;
    bottom: 5px;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 5px;
    background: rgba(8, 5, 18, 0.8);
    color: #fff;
  }
  .live {
    left: 5px;
    right: auto;
    background: var(--danger);
  }
  .info {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .chips {
    display: flex;
    gap: 5px;
  }
  .title {
    font-weight: 650;
    font-size: 13.5px;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .desc {
    font-size: 11.5px;
    color: var(--muted);
  }
  .sniff {
    color: var(--carrot);
  }
  .chev {
    color: var(--faint);
    transition: transform 0.25s;
    display: grid;
  }
  .chev.open {
    transform: rotate(180deg);
    color: var(--carrot);
  }
  .panel {
    padding: 4px 14px 14px;
    animation: pop-in 0.3s both;
  }
  .single {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 10px;
    padding: 10px 0 4px;
  }
  .single .big {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  .single .size {
    color: var(--carrot);
    font-size: 12px;
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-top: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    color: var(--muted);
  }
  .toggle input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .sw {
    width: 32px;
    height: 18px;
    border-radius: 99px;
    background: var(--surface-3);
    position: relative;
    transition: background 0.2s;
  }
  .sw::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.25s cubic-bezier(0.3, 1.5, 0.5, 1);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  .toggle input:checked + .sw {
    background: var(--grad);
  }
  .toggle input:checked + .sw::after {
    transform: translateX(14px);
  }
  .toggle input:checked ~ :global(svg) {
    color: var(--carrot);
  }
  .toggle input:focus-visible + .sw {
    box-shadow: var(--ring);
  }
  .seg {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    border-radius: 11px;
    background: var(--surface);
    border: 1px solid var(--stroke);
  }
  .seg button {
    border: 0;
    background: none;
    font-size: 11.5px;
    font-weight: 700;
    padding: 4px 8px;
    border-radius: 8px;
    color: var(--muted);
  }
  .seg button.on {
    background: var(--surface-3);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }
  .grab {
    position: relative;
    margin-top: 12px;
    width: 100%;
    height: 48px;
    border: 0;
    border-radius: 15px;
    background: var(--grad);
    color: #fff;
    font-weight: 750;
    font-size: 15px;
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    box-shadow: var(--glow);
    overflow: hidden;
    transition:
      transform 0.12s,
      filter 0.2s;
  }
  .grab::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(110deg, transparent 30%, rgba(255, 255, 255, 0.35) 50%, transparent 70%);
    transform: translateX(-100%);
    transition: transform 0.7s;
  }
  .grab:hover::before {
    transform: translateX(100%);
  }
  .grab:hover {
    filter: brightness(1.07);
  }
  .grab:active {
    transform: scale(0.98);
  }
  .grab:disabled {
    opacity: 0.7;
  }
  .bunny {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.2);
  }
  .bunny.go {
    animation: hop 0.6s infinite;
  }
  .est {
    font-size: 12px;
    font-weight: 600;
    opacity: 0.85;
    padding: 2px 8px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.16);
  }
  .progress {
    margin-top: 12px;
  }
  .pmeta {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--muted);
    margin-top: 6px;
  }
  .spd {
    color: var(--carrot);
  }
  .notice {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 11px 12px;
    border-radius: 13px;
    font-size: 12.5px;
    line-height: 1.45;
    margin: 8px 0;
  }
  .notice.danger {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 22%, transparent);
  }
  .notice.warn {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--warn) 22%, transparent);
  }
  .notice.small {
    font-size: 12px;
    padding: 8px 10px;
  }
  .blocked .title {
    opacity: 0.7;
  }
</style>
