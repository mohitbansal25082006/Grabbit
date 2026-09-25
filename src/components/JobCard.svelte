<script lang="ts">
  import type { Job } from '@/lib/types';
  import { formatBytes, formatEta, formatSpeed } from '@/lib/util';
  import Hopper from './Hopper.svelte';
  import Icon from './Icon.svelte';
  import SegmentMosaic from './SegmentMosaic.svelte';
  import Sparkline from './Sparkline.svelte';

  let { job, compact = false, onaction }: { job: Job; compact?: boolean; onaction: (id: string, action: string) => void } = $props();

  const STATUS: Record<string, string> = {
    queued: 'Queued',
    preparing: 'Preparing',
    downloading: 'Downloading',
    recording: 'Recording live',
    paused: 'Paused',
    muxing: 'Merging',
    saving: 'Saving',
    done: 'Done',
    error: 'Failed',
    canceled: 'Canceled',
  };

  const progress = $derived.by(() => {
    if (job.status === 'done') return 1;
    if (job.status === 'muxing') return job.muxProgress ?? 0;
    if (job.totalBytes) return Math.min(0.999, job.doneBytes / job.totalBytes);
    if (job.totalParts) return job.doneParts / job.totalParts;
    return 0;
  });
  const hopState = $derived(
    job.status === 'done' ? 'done' : job.status === 'error' || job.status === 'canceled' ? 'error' : job.status === 'paused' || job.status === 'queued' ? 'paused' : job.status === 'muxing' || job.status === 'saving' ? 'muxing' : 'active',
  );
  const indeterminate = $derived(job.status === 'preparing' || job.status === 'recording' || job.status === 'saving' || (job.status === 'downloading' && !job.totalBytes && !job.totalParts));
  const running = $derived(['preparing', 'downloading', 'recording', 'muxing', 'saving'].includes(job.status));
  const pct = $derived(Math.round(progress * 100));
</script>

<article class="job {job.status}" class:compact>
  <div class="thumb">
    {#if job.request.thumbnail}
      <img src={job.request.thumbnail} alt="" loading="lazy" referrerpolicy="no-referrer" />
    {:else}
      <div class="ph"><Icon name="film" size={compact ? 18 : 26} /></div>
    {/if}
    <span class="q mono">{job.request.qualityLabel}</span>
  </div>

  <div class="body">
    <div class="top">
      <div class="title ellipsis" title={job.request.title}>{job.request.title}</div>
      <div class="actions">
        {#if job.status === 'recording'}
          <button class="btn sm stopbtn" onclick={() => onaction(job.id, 'stop')} title="Stop & save"><Icon name="stop" size={12} /> Stop</button>
        {:else if running || job.status === 'queued'}
          <button class="btn sm icon ghost" onclick={() => onaction(job.id, 'pause')} title="Pause" aria-label="Pause"><Icon name="pause" size={16} /></button>
        {/if}
        {#if job.status === 'paused'}
          <button class="btn sm icon ghost" onclick={() => onaction(job.id, 'resume')} title="Resume" aria-label="Resume"><Icon name="play" size={15} /></button>
        {/if}
        {#if job.status === 'error' || job.status === 'canceled'}
          <button class="btn sm icon ghost" onclick={() => onaction(job.id, 'retry')} title="Retry" aria-label="Retry"><Icon name="refresh" size={16} /></button>
        {/if}
        {#if job.status === 'done' && job.downloadId != null}
          <button class="btn sm icon ghost" onclick={() => onaction(job.id, 'open')} title="Open file" aria-label="Open file"><Icon name="play" size={15} /></button>
          <button class="btn sm icon ghost" onclick={() => onaction(job.id, 'show')} title="Show in folder" aria-label="Show in folder"><Icon name="folder" size={16} /></button>
        {/if}
        {#if running || job.status === 'queued' || job.status === 'paused'}
          <button class="btn sm icon ghost danger" onclick={() => onaction(job.id, 'cancel')} title="Cancel" aria-label="Cancel"><Icon name="x" size={16} /></button>
        {:else}
          <button class="btn sm icon ghost danger" onclick={() => onaction(job.id, 'remove')} title="Remove from list" aria-label="Remove"><Icon name="trash" size={15} /></button>
        {/if}
      </div>
    </div>

    <div class="meta">
      <span class="status">
        {#if job.status === 'done'}<Icon name="check" size={13} />{/if}
        {STATUS[job.status]}{#if job.status === 'muxing'}&nbsp;{pct}%{/if}
      </span>
      <span class="dot">•</span><span class="ellipsis">{job.site}</span>
      {#if job.status === 'done' && (job.outputSize || job.outputs?.[0]?.size)}
        <span class="dot">•</span><span class="mono">{formatBytes(job.outputs?.[0]?.size ?? job.outputSize)}</span>
      {:else if job.totalBytes && job.status !== 'done'}
        <span class="dot">•</span><span class="mono">{formatBytes(job.doneBytes)} / {formatBytes(job.totalBytes)}</span>
      {:else if job.doneBytes && job.status !== 'done'}
        <span class="dot">•</span><span class="mono">{formatBytes(job.doneBytes)}</span>
      {/if}
    </div>

    {#if job.status !== 'done' || !compact}
      <Hopper value={progress} state={hopState} {indeterminate} height={compact ? 6 : 8} />
    {/if}

    {#if job.status === 'downloading' || job.status === 'recording'}
      <div class="stats mono">
        <span class="speed"><Icon name="bolt" size={12} />{formatSpeed(job.speed)}</span>
        {#if job.eta}<span>ETA {formatEta(job.eta)}</span>{/if}
        <span title="Parallel connections (adaptive)">{job.connections} lanes</span>
        {#if !compact && job.totalParts > 1}<span>{job.doneParts}/{job.totalParts} parts</span>{/if}
        {#if !compact}<span class="pct">{pct}%</span>{/if}
      </div>
    {/if}

    {#if job.error}<div class="err">{job.error}</div>{/if}
    {#if job.warning && job.status === 'done'}<div class="warn">{job.warning}</div>{/if}

    {#if !compact && job.mosaic && (running || job.status === 'paused')}
      <div class="viz">
        <div class="mz"><SegmentMosaic mosaic={job.mosaic} height={46} live={running} /></div>
        {#if job.speedHistory?.length}<div class="spark"><Sparkline values={job.speedHistory} height={46} /></div>{/if}
      </div>
    {/if}
  </div>
</article>

<style>
  .job {
    display: grid;
    grid-template-columns: 148px 1fr;
    gap: 16px;
    padding: 14px;
    border-radius: 20px;
    background: var(--surface);
    border: 1px solid var(--stroke);
    animation: pop-in 0.35s cubic-bezier(0.2, 1.2, 0.4, 1) both;
    transition:
      border-color 0.2s,
      background 0.2s;
  }
  .job:hover {
    border-color: var(--stroke-2);
  }
  .job.downloading,
  .job.recording {
    background: linear-gradient(var(--surface), var(--surface)) padding-box, linear-gradient(135deg, color-mix(in srgb, var(--carrot) 45%, transparent), transparent 60%) border-box;
    border-color: transparent;
  }
  .compact {
    grid-template-columns: 64px 1fr;
    gap: 11px;
    padding: 10px;
    border-radius: 16px;
  }
  .thumb {
    position: relative;
    aspect-ratio: 16/9;
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-3);
    align-self: start;
  }
  .compact .thumb {
    border-radius: 9px;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .ph {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--faint);
    background: var(--grad-soft);
  }
  .q {
    position: absolute;
    right: 5px;
    bottom: 5px;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 6px;
    background: rgba(8, 5, 18, 0.78);
    color: #fff;
  }
  .compact .q {
    display: none;
  }
  .body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .top {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .title {
    flex: 1;
    font-weight: 650;
    font-size: 14.5px;
    letter-spacing: -0.01em;
    padding-top: 4px;
  }
  .compact .title {
    font-size: 13px;
    padding-top: 2px;
  }
  .actions {
    display: flex;
    gap: 2px;
    margin: -2px -4px 0 0;
  }
  .compact .actions :global(.btn.sm.icon) {
    width: 26px;
    height: 26px;
  }
  .stopbtn {
    color: var(--danger);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    min-width: 0;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 700;
    color: var(--text);
    white-space: nowrap;
  }
  .done .status {
    color: var(--mint);
  }
  .error .status {
    color: var(--danger);
  }
  .recording .status {
    color: var(--danger);
  }
  .recording .status::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger);
    animation: blink 1s infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0.2;
    }
  }
  .dot {
    color: var(--faint);
  }
  .stats {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 11.5px;
    color: var(--muted);
    margin-top: 6px;
  }
  .speed {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--carrot);
    font-weight: 700;
  }
  .pct {
    margin-left: auto;
    color: var(--text);
    font-weight: 700;
  }
  .err,
  .warn {
    margin-top: 8px;
    font-size: 12px;
    padding: 8px 10px;
    border-radius: 10px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 22%, transparent);
  }
  .warn {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 9%, transparent);
    border-color: color-mix(in srgb, var(--warn) 22%, transparent);
  }
  .viz {
    display: grid;
    grid-template-columns: 1fr 180px;
    gap: 14px;
    margin-top: 12px;
    align-items: center;
  }
  .mz {
    min-width: 0;
  }
  @media (max-width: 720px) {
    .job {
      grid-template-columns: 96px 1fr;
    }
    .viz {
      grid-template-columns: 1fr;
    }
    .spark {
      display: none;
    }
  }
</style>
