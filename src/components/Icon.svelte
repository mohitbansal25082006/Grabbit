<script lang="ts" module>
  // Hand-drawn 24px stroke icon set for Grabbit.
  const P: Record<string, string> = {
    download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
    pause: 'M9 5.5v13M15 5.5v13',
    play: 'M8 5.5v13l10.5-6.5z',
    x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    folder: 'M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.8h-4.8',
    lock: 'M6.5 11h11v9h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    record: 'M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z',
    stop: 'M7 7h10v10H7z',
    trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5',
    external: 'M13.5 4.5h6v6M19.5 4.5l-8.5 8.5M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    bolt: 'M13 3.5 5.5 13h5.5l-1 7.5 7.5-9.5h-5.5z',
    music: 'M9 17.5V6l10-2v11.5M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
    captions: 'M3.5 6.5h17v11h-17zM10.5 10.5a2 2 0 1 0 0 3M16.5 10.5a2 2 0 1 0 0 3',
    clock: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2',
    info: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 11v5.5M12 7.8v.2',
    chevron: 'M6.5 9.5 12 15l5.5-5.5',
    globe: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z',
    keyboard: 'M3.5 7h17v10h-17zM7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17.5 10.5h.01M8 14h8',
    sparkle: 'M12 3.5l1.9 5.2 5.1 1.8-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.8zM18.5 16l.8 2 2 .7-2 .8-.8 2-.7-2-2-.8 2-.7z',
    inbox: 'M3.5 13.5l2.5-8h12l2.5 8v5h-17zM3.5 13.5h5l1 2h5l1-2h5',
    shield: 'M12 3.5l7 2.5v6c0 4.2-2.9 7.3-7 8.5-4.1-1.2-7-4.3-7-8.5V6z',
    film: 'M4 4.5h16v15H4zM8 4.5v15M16 4.5v15M4 9h4M4 15h4M16 9h4M16 15h4',
    sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
    moon: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z',
    plus: 'M12 5v14M5 12h14',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    radar: 'M12 12m-1.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M7.8 16.2a6 6 0 1 1 8.4 0M5 19a10 10 0 1 1 14 0',
  };
  const FILLED = new Set(['play', 'record', 'stop']);
</script>

<script lang="ts">
  let { name, size = 18, stroke = 1.9 }: { name: string; size?: number; stroke?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={FILLED.has(name) ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  style="flex-shrink:0"
>
  <path d={P[name] ?? P.info} />
</svg>
