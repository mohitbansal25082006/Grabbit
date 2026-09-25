<script lang="ts">
  // Progress bar with a tiny rabbit hopping at the leading edge.
  let {
    value = 0,
    state = 'active',
    indeterminate = false,
    height = 8,
  }: { value?: number; state?: 'active' | 'paused' | 'done' | 'error' | 'muxing'; indeterminate?: boolean; height?: number } = $props();
  const pct = $derived(Math.max(0, Math.min(1, value)) * 100);
</script>

<div class="hopper {state}" class:indeterminate style="--h:{height}px" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(pct)}>
  <div class="track">
    <div class="fill" style="width:{indeterminate ? 100 : pct}%"></div>
  </div>
  {#if !indeterminate && state !== 'done' && state !== 'error'}
    <span class="bunny" class:hopping={state === 'active' || state === 'muxing'} style="left:calc({pct}% - 9px)">
      <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true"
        ><path
          fill="currentColor"
          d="M11.2 2.4c1.9 0 2.9 3 2.9 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6.9-6.6 2.8-6.6Zm9.6 0c1.9 0 2.8 3 2.8 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6 1-6.6 2.9-6.6ZM16 11.4c5 0 9 3.9 9 8.8S21 29.6 16 29.6s-9-4.5-9-9.4 4-8.8 9-8.8Z"
        /></svg
      >
    </span>
  {/if}
</div>

<style>
  .hopper {
    position: relative;
    padding-top: 12px;
  }
  .track {
    height: var(--h);
    border-radius: 999px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    border-radius: inherit;
    background: var(--grad);
    transition: width 0.45s cubic-bezier(0.2, 0.9, 0.3, 1);
    box-shadow: 0 0 16px -2px color-mix(in srgb, var(--carrot) 70%, transparent);
  }
  .done .fill {
    background: var(--grad-mint);
    box-shadow: none;
  }
  .error .fill {
    background: var(--danger);
    box-shadow: none;
  }
  .paused .fill {
    background: var(--faint);
    box-shadow: none;
  }
  .muxing .fill {
    background: linear-gradient(90deg, var(--violet), var(--sky));
  }
  .indeterminate .fill {
    background: repeating-linear-gradient(-45deg, var(--carrot) 0 10px, var(--rose) 10px 20px);
    background-size: 200% 100%;
    animation: stripes 1s linear infinite;
    opacity: 0.8;
  }
  @keyframes stripes {
    to {
      background-position: -28px 0;
    }
  }
  .bunny {
    position: absolute;
    top: -6px;
    color: var(--text);
    transition: left 0.45s cubic-bezier(0.2, 0.9, 0.3, 1);
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.4));
  }
  .paused .bunny {
    color: var(--faint);
  }
  .bunny.hopping svg {
    animation: hop 0.62s cubic-bezier(0.3, 1.6, 0.5, 1) infinite;
    transform-origin: 50% 100%;
  }
</style>
