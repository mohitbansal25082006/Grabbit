<script lang="ts">
  let { values = [], height = 36, color = 'var(--carrot)' }: { values?: number[]; height?: number; color?: string } = $props();
  const id = `sp${Math.random().toString(36).slice(2, 8)}`;
  const W = 200;
  const pts = $derived.by(() => {
    const v = values.length > 1 ? values : [0, ...values, 0];
    const max = Math.max(1, ...v);
    return v.map((y, i) => [(i / (v.length - 1)) * W, height - 3 - (y / max) * (height - 8)] as const);
  });
  const line = $derived(
    pts.reduce((d, [x, y], i) => {
      if (i === 0) return `M${x},${y}`;
      const [px, py] = pts[i - 1];
      const cx = (px + x) / 2;
      return `${d} C${cx},${py} ${cx},${y} ${x},${y}`;
    }, ''),
  );
  const area = $derived(`${line} L${W},${height} L0,${height} Z`);
  const last = $derived(pts[pts.length - 1]);
</script>

<svg viewBox="0 0 {W} {height}" preserveAspectRatio="none" style="width:100%;height:{height}px;display:block" aria-hidden="true">
  <defs>
    <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color={color} stop-opacity="0.35" />
      <stop offset="100%" stop-color={color} stop-opacity="0" />
    </linearGradient>
  </defs>
  <path d={area} fill="url(#{id})" />
  <path d={line} fill="none" stroke={color} stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
  {#if last}<circle cx={last[0] - 2} cy={last[1]} r="2.6" fill={color} vector-effect="non-scaling-stroke" />{/if}
</svg>
