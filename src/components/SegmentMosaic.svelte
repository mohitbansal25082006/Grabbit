<script lang="ts">
  // Live grid of every segment/chunk in a download: pending, in-flight (pulsing), done, retrying.
  import { onMount } from 'svelte';

  let { mosaic = '', height = 44, live = true }: { mosaic?: string; height?: number; live?: boolean } = $props();
  let canvas: HTMLCanvasElement;
  let wrap: HTMLDivElement;
  let width = $state(300);
  let raf = 0;

  function color(name: string) {
    return getComputedStyle(canvas).getPropertyValue(name).trim() || '#888';
  }

  function draw(t: number) {
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = width;
    const H = height;
    if (canvas.width !== Math.round(W * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const n = mosaic.length;
    if (!n) return;
    let cols = Math.max(1, Math.ceil(Math.sqrt((n * W) / H)));
    let rows = Math.ceil(n / cols);
    // Cap tile size so small jobs still read as a grid, not a few giant blocks.
    const cell = Math.min(W / cols, H / rows, 14);
    cols = Math.max(1, Math.min(n, Math.floor(W / cell)));
    rows = Math.ceil(n / cols);
    const gap = cell > 6 ? 2 : cell > 3.5 ? 1 : 0.5;
    const s = Math.max(1, cell - gap);
    const ox = 0;
    const oy = Math.max(0, (H - rows * cell) / 2);
    const c = {
      pending: color('--surface-3'),
      active: color('--carrot'),
      mint: color('--mint'),
      sky: color('--sky'),
      retry: color('--warn'),
    };
    const pulse = 0.55 + 0.45 * Math.sin(t / 160);
    for (let i = 0; i < n; i++) {
      const st = mosaic.charCodeAt(i) - 48;
      const x = ox + (i % cols) * cell;
      const y = oy + Math.floor(i / cols) * cell;
      ctx.globalAlpha = 1;
      if (st === 2) {
        ctx.fillStyle = i / n < 0.5 ? c.mint : c.sky;
        ctx.globalAlpha = 0.72 + 0.28 * (1 - Math.abs(i / n - 0.5) * 2);
      } else if (st === 1) {
        ctx.fillStyle = c.active;
        ctx.globalAlpha = pulse;
      } else if (st === 3) ctx.fillStyle = c.retry;
      else if (st === 4) {
        ctx.fillStyle = c.mint;
        ctx.globalAlpha = 0.35;
      } else ctx.fillStyle = c.pending;
      const r = Math.min(2, s / 3);
      ctx.beginPath();
      ctx.roundRect(x, y, s, s, r);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function loop(t: number) {
    draw(t);
    if (live && mosaic.includes('1')) raf = requestAnimationFrame(loop);
    else raf = 0;
  }

  $effect(() => {
    void mosaic;
    void width;
    void live;
    if (!raf) raf = requestAnimationFrame(loop);
  });

  onMount(() => {
    const ro = new ResizeObserver(([e]) => (width = e.contentRect.width));
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  });
</script>

<div bind:this={wrap} class="mosaic" style="height:{height}px" aria-label="Segment progress map" role="img">
  <canvas bind:this={canvas} style="width:{width}px;height:{height}px"></canvas>
</div>

<style>
  .mosaic {
    width: 100%;
    position: relative;
  }
  canvas {
    display: block;
  }
</style>
