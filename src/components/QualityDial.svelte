<script lang="ts">
  // The Quality Dial: a rotary knob that snaps to available qualities.
  // Drag, scroll, click a label, or use arrow keys. Lowest quality on the left, best on the right.
  export interface DialOption {
    id: string;
    label: string;
    sub?: string;
    size?: string;
  }
  let {
    options,
    value = $bindable(),
    onchange,
    size = 210,
  }: { options: DialOption[]; value?: string; onchange?: (id: string) => void; size?: number } = $props();

  const C = 110; // center in viewBox units
  const R = 78; // arc radius
  const START = -135;
  const SWEEP = 270;

  const idx = $derived(Math.max(0, options.findIndex((o) => o.id === value)));
  const n = $derived(options.length);
  const angleOf = (i: number) => (n <= 1 ? 0 : START + (SWEEP * i) / (n - 1));
  const angle = $derived(angleOf(idx));
  const current = $derived(options[idx]);

  const polar = (deg: number, r: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [C + r * Math.cos(rad), C + r * Math.sin(rad)] as const;
  };
  const arc = (from: number, to: number, r: number) => {
    const [x1, y1] = polar(from, r);
    const [x2, y2] = polar(to, r);
    const large = to - from > 180 ? 1 : 0;
    return `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2}`;
  };
  const trackPath = arc(START, START + SWEEP, R);
  const arcLen = (Math.PI * 2 * R * SWEEP) / 360;
  const progress = $derived(n <= 1 ? 1 : idx / (n - 1));

  let svgEl: SVGSVGElement;
  let dragging = $state(false);

  function select(i: number) {
    const o = options[Math.max(0, Math.min(n - 1, i))];
    if (o && o.id !== value) {
      value = o.id;
      onchange?.(o.id);
      navigator.vibrate?.(4);
    }
  }

  function fromPointer(e: PointerEvent) {
    const r = svgEl.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
    if (deg > 180) deg -= 360;
    deg = Math.max(START, Math.min(START + SWEEP, deg));
    if (n > 1) select(Math.round(((deg - START) / SWEEP) * (n - 1)));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') select(idx + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') select(idx - 1);
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(n - 1);
    else return;
    e.preventDefault();
  }

  let wheelAcc = 0;
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 40) {
      select(idx + (wheelAcc < 0 ? 1 : -1));
      wheelAcc = 0;
    }
  }
  const gid = `dial${Math.random().toString(36).slice(2, 7)}`;
</script>

<div class="dial" class:dragging style="--size:{size}px">
  <svg
    bind:this={svgEl}
    viewBox="0 0 220 220"
    role="slider"
    tabindex="0"
    aria-label="Video quality"
    aria-valuemin={0}
    aria-valuemax={Math.max(0, n - 1)}
    aria-valuenow={idx}
    aria-valuetext={current?.label}
    onkeydown={onKey}
    onwheel={onWheel}
    onpointerdown={(e) => {
      dragging = true;
      svgEl.setPointerCapture(e.pointerId);
      fromPointer(e);
    }}
    onpointermove={(e) => dragging && fromPointer(e)}
    onpointerup={() => (dragging = false)}
    onpointercancel={() => (dragging = false)}
  >
    <defs>
      <linearGradient id="{gid}g" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stop-color="var(--carrot)" />
        <stop offset="100%" stop-color="var(--rose)" />
      </linearGradient>
      <radialGradient id="{gid}k" cx="40%" cy="30%" r="80%">
        <stop offset="0%" stop-color="var(--knob-a)" />
        <stop offset="100%" stop-color="var(--knob-b)" />
      </radialGradient>
    </defs>

    <!-- tick ring -->
    {#each Array(37) as _, i}
      {@const a = START + (SWEEP * i) / 36}
      {@const [x1, y1] = polar(a, R + 12)}
      {@const [x2, y2] = polar(a, R + (i % 6 === 0 ? 17 : 15))}
      <line {x1} {y1} {x2} {y2} class="tick" class:lit={a <= angle + 0.01} />
    {/each}

    <path d={trackPath} class="track" />
    <path
      d={trackPath}
      class="progress"
      stroke="url(#{gid}g)"
      style="stroke-dasharray:{arcLen};stroke-dashoffset:{arcLen * (1 - progress)}"
    />

    <!-- option stops + labels -->
    {#each options as o, i}
      {@const a = angleOf(i)}
      {@const [sx, sy] = polar(a, R)}
      {@const [lx, ly] = polar(a, R + 31)}
      <circle cx={sx} cy={sy} r={i === idx ? 0 : 3} class="stop" class:passed={i < idx} />
      {#if n <= 9 || i === idx || i === 0 || i === n - 1}
        <text
          x={lx}
          y={ly + 4}
          class="opt"
          class:sel={i === idx}
          text-anchor={Math.abs(a) < 20 ? 'middle' : a < 0 ? 'end' : 'start'}
          role="presentation"
          onpointerdown={(e) => {
            e.stopPropagation();
            select(i);
          }}>{o.label.replace(/p(\d+)?$/, '')}</text
        >
      {/if}
    {/each}

    <!-- knob -->
    <circle cx={C} cy={C} r="56" fill="url(#{gid}k)" class="knob" />
    <circle cx={C} cy={C} r="56" class="knob-ring" />
    <g class="pointer" style="transform:rotate({angle}deg)">
      <rect x={C - 2.5} y={C - 52} width="5" height="14" rx="2.5" fill="url(#{gid}g)" />
      {#if true}
        {@const [gx, gy] = polar(0, R)}
        <circle cx={gx} cy={gy} r="7.5" class="thumb" />
        <circle cx={gx} cy={gy} r="3.2" fill="#fff" />
      {/if}
    </g>
  </svg>
  <div class="center" aria-hidden="true">
    <div class="big">{current?.label ?? '—'}</div>
    {#if current?.sub}<div class="sub">{current.sub}</div>{/if}
    {#if current?.size}<div class="size mono">{current.size}</div>{/if}
  </div>
</div>

<style>
  .dial {
    position: relative;
    width: var(--size);
    height: var(--size);
    margin: 0 auto;
    user-select: none;
    touch-action: none;
  }
  svg {
    width: 100%;
    height: 100%;
    overflow: visible;
    cursor: grab;
    border-radius: 50%;
  }
  .dragging svg {
    cursor: grabbing;
  }
  .tick {
    stroke: var(--stroke-2);
    stroke-width: 1.4;
    stroke-linecap: round;
    transition: stroke 0.3s;
  }
  .tick.lit {
    stroke: color-mix(in srgb, var(--carrot) 70%, transparent);
  }
  .track {
    fill: none;
    stroke: var(--surface-3);
    stroke-width: 9;
    stroke-linecap: round;
  }
  .progress {
    fill: none;
    stroke-width: 9;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.45s cubic-bezier(0.25, 1.3, 0.4, 1);
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--carrot) 60%, transparent));
  }
  .stop {
    fill: var(--faint);
    transition: r 0.2s;
  }
  .stop.passed {
    fill: rgba(255, 255, 255, 0.9);
  }
  .opt {
    font: 600 10.5px 'JetBrains Mono Variable', ui-monospace, monospace;
    fill: var(--muted);
    cursor: pointer;
    transition: fill 0.2s;
  }
  .opt:hover {
    fill: var(--text);
  }
  .opt.sel {
    fill: var(--carrot);
    font-weight: 800;
  }
  .knob {
    filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.45));
  }
  .knob-ring {
    fill: none;
    stroke: var(--stroke-2);
    stroke-width: 1;
  }
  .pointer {
    transform-origin: 110px 110px;
    transition: transform 0.45s cubic-bezier(0.25, 1.35, 0.4, 1);
  }
  .thumb {
    fill: var(--carrot);
    stroke: var(--bg);
    stroke-width: 3;
    filter: drop-shadow(0 0 8px var(--carrot));
  }
  .center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    gap: 1px;
  }
  .big {
    font-size: 25px;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .sub {
    font-size: 10.5px;
    color: var(--muted);
    font-weight: 600;
    letter-spacing: 0.04em;
    max-width: 96px;
    text-align: center;
  }
  .size {
    font-size: 11px;
    color: var(--carrot);
    margin-top: 3px;
  }
</style>
