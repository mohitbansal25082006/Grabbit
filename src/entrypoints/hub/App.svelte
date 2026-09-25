<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Icon from '@/components/Icon.svelte';
  import JobCard from '@/components/JobCard.svelte';
  import Logo from '@/components/Logo.svelte';
  import SettingsPanel from '@/components/Settings.svelte';
  import Sparkline from '@/components/Sparkline.svelte';
  import { createJobs, createSettings, fileAction } from '@/components/stores.svelte';
  import { bg } from '@/lib/messaging';
  import { isActive, type Job } from '@/lib/types';
  import { formatBytes, formatSpeed } from '@/lib/util';

  type Route = 'downloads' | 'history' | 'settings' | 'welcome';
  const jobs = createJobs();
  const settings = createSettings();
  let route = $state<Route>('downloads');
  let query = $state('');
  let globalHistory = $state<number[]>([]);
  let tick: ReturnType<typeof setInterval>;

  const readRoute = () => {
    const h = location.hash.replace('#', '') as Route;
    route = (['downloads', 'history', 'settings', 'welcome'] as Route[]).includes(h) ? h : 'downloads';
  };

  onMount(() => {
    readRoute();
    window.addEventListener('hashchange', readRoute);
    tick = setInterval(() => {
      const total = jobs.list.filter((j) => j.status === 'downloading' || j.status === 'recording').reduce((a, j) => a + (j.speed || 0), 0);
      globalHistory = [...globalHistory, total].slice(-50);
    }, 1000);
  });
  onDestroy(() => {
    clearInterval(tick);
    window.removeEventListener('hashchange', readRoute);
    jobs.destroy();
    settings.destroy();
  });

  const go = (r: Route) => (location.hash = r);
  let toast = $state('');
  let toastTimer: ReturnType<typeof setTimeout>;
  function flash(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 3500);
  }
  async function clearHistory() {
    if (!confirm(`Remove ${finished.length} item${finished.length === 1 ? '' : 's'} from history? Files stay in your Downloads folder.`)) return;
    try {
      await jobs.clear();
      await jobs.refresh();
      flash('History cleared');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  const running = $derived(jobs.list.filter((j) => isActive(j)));
  const waiting = $derived(jobs.list.filter((j) => j.status === 'paused'));
  const recent = $derived(jobs.list.filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'canceled').slice(0, 6));
  const finished = $derived(
    jobs.list
      .filter((j) => !isActive(j) && j.status !== 'paused')
      .filter((j) => !query || `${j.request.title} ${j.site} ${j.filename}`.toLowerCase().includes(query.toLowerCase())),
  );
  const speed = $derived(running.reduce((a, j) => a + (j.status === 'downloading' || j.status === 'recording' ? j.speed || 0 : 0), 0));
  const totalSaved = $derived(jobs.list.filter((j) => j.status === 'done').reduce((a, j) => a + (j.outputs?.[0]?.size ?? j.outputSize ?? j.doneBytes ?? 0), 0));
  const doneCount = $derived(jobs.list.filter((j) => j.status === 'done').length);

  async function jobAction(id: string, action: string) {
    const j = jobs.list.find((x) => x.id === id);
    try {
      if (action === 'open' || action === 'show') await fileAction(j, action);
      else await jobs.action(id, action);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }
</script>

<div class="atmosphere"></div>
{#if toast}<div class="toast" role="status">{toast}</div>{/if}
<div class="shell">
  <aside>
    <div class="brand">
      <Logo size={40} animated={running.length > 0} />
      <div>
        <div class="word">Grabbit</div>
        <div class="ver">v{chrome.runtime.getManifest().version}</div>
      </div>
    </div>

    <nav>
      <button class:on={route === 'downloads'} onclick={() => go('downloads')}>
        <Icon name="download" /> Downloads {#if running.length}<span class="count mono">{running.length}</span>{/if}
      </button>
      <button class:on={route === 'history'} onclick={() => go('history')}><Icon name="clock" /> History</button>
      <button class:on={route === 'settings'} onclick={() => go('settings')}><Icon name="sliders" /> Settings</button>
      <button class:on={route === 'welcome'} onclick={() => go('welcome')}><Icon name="info" /> How it works</button>
    </nav>

    <div class="meter">
      <div class="meter-h"><span class="label">Live speed</span><span class="mono spd">{formatSpeed(speed)}</span></div>
      <Sparkline values={globalHistory} height={44} />
      <div class="meter-f mono"><span>{doneCount} grabbed</span><span>{formatBytes(totalSaved)}</span></div>
    </div>
    <div class="privacy"><Icon name="shield" size={14} /> Runs 100% locally. No tracking.</div>
  </aside>

  <main>
    {#if route === 'downloads'}
      <div class="page-h">
        <div>
          <h1>Downloads</h1>
          <p class="muted">Parallel, adaptive, resumable. Watch every segment land.</p>
        </div>
        <div class="tools">
          <button class="btn" onclick={() => chrome.downloads.showDefaultFolder()}><Icon name="folder" size={16} /> Open folder</button>
        </div>
      </div>

      {#if !jobs.loaded}
        <div class="skeleton" style="height:150px;border-radius:20px"></div>
      {:else if !running.length && !waiting.length && !recent.length}
        <div class="hero-empty">
          <div class="hole"><Logo size={72} /></div>
          <h2>The burrow is empty</h2>
          <p>Open a page with a video, click the Grabbit icon (or hover the video and press <b>Grab</b>), and your downloads show up here — with live speed, lanes and a segment map.</p>
          <div class="kbd-hint"><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> grabs the best video on any page.</div>
        </div>
      {/if}

      {#if running.length}
        <h4 class="sec">Active <span class="mono">{running.length}</span></h4>
        <div class="stack">
          {#each running as j (j.id)}<JobCard job={j as Job} onaction={jobAction} />{/each}
        </div>
      {/if}
      {#if waiting.length}
        <h4 class="sec">Paused <span class="mono">{waiting.length}</span></h4>
        <div class="stack">
          {#each waiting as j (j.id)}<JobCard job={j as Job} onaction={jobAction} />{/each}
        </div>
      {/if}
      {#if recent.length}
        <h4 class="sec">Recently finished <button class="linkbtn" onclick={() => go('history')}>See all</button></h4>
        <div class="stack">
          {#each recent as j (j.id)}<JobCard job={j as Job} compact onaction={jobAction} />{/each}
        </div>
      {/if}
    {:else if route === 'history'}
      <div class="page-h">
        <div>
          <h1>History</h1>
          <p class="muted">{finished.length} item{finished.length === 1 ? '' : 's'} · files stay in your Downloads folder when removed here.</p>
        </div>
        <div class="tools">
          <input class="input search" placeholder="Search titles, sites…" bind:value={query} />
          <button class="btn danger" onclick={clearHistory} disabled={!finished.length}><Icon name="trash" size={15} /> Clear</button>
        </div>
      </div>
      {#if !finished.length}
        <div class="hero-empty small"><Icon name="clock" size={30} /><p>Nothing here yet.</p></div>
      {:else}
        <div class="stack">
          {#each finished as j (j.id)}<JobCard job={j as Job} compact onaction={jobAction} />{/each}
        </div>
      {/if}
    {:else if route === 'settings'}
      <div class="page-h">
        <div>
          <h1>Settings</h1>
          <p class="muted">Saved instantly. Synced across Grabbit’s popup, page button and engine.</p>
        </div>
      </div>
      <SettingsPanel value={settings.value} onchange={(p) => settings.set(p)} />
    {:else}
      <div class="welcome">
        <div class="w-hero">
          <Logo size={88} animated />
          <h1>Welcome to <span class="grad-text">Grabbit</span></h1>
          <p>Grab videos from the web in the best available quality — with a turbo engine that splits every download into parallel lanes.</p>
        </div>
        <div class="steps">
          <div class="step">
            <span class="n mono">01</span>
            <h3>Play a video</h3>
            <p>Grabbit sniffs HLS, DASH, MP4, WebM and more the moment the player loads them — even streams hidden behind APIs.</p>
          </div>
          <div class="step">
            <span class="n mono">02</span>
            <h3>Turn the dial</h3>
            <p>Pick 4K, 1080p, audio-only or anything in between. Size estimates update live. Choose MP4, MKV or raw.</p>
          </div>
          <div class="step">
            <span class="n mono">03</span>
            <h3>Watch it fly</h3>
            <p>Up to 32 adaptive connections, resumable chunks and lossless remuxing. The segment map shows every piece landing.</p>
          </div>
        </div>
        <div class="facts">
          <div><Icon name="bolt" /><b>Adaptive parallel lanes</b><span>Scales connections up while speed improves, backs off on throttling.</span></div>
          <div><Icon name="refresh" /><b>Pause & resume</b><span>Survives browser restarts — finished chunks are never re-downloaded.</span></div>
          <div><Icon name="record" /><b>Record while playing</b><span>A fallback for players with hidden streams (Turbo 8× available).</span></div>
          <div><Icon name="shield" /><b>Respectful by design</b><span>DRM-protected video and YouTube are not supported. Only download what you have the right to.</span></div>
        </div>
        <div class="cta">
          <button class="btn primary" onclick={() => go('downloads')}>Let’s grab <Icon name="download" size={16} /></button>
          <button class="btn" onclick={() => go('settings')}>Tune settings</button>
        </div>
        <p class="pin muted"><Icon name="info" size={14} /> Tip: pin Grabbit from the puzzle-piece menu so the carrot counter is always visible.</p>
      </div>
    {/if}
  </main>
</div>

<style>
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    padding: 12px 18px;
    border-radius: 14px;
    background: var(--bg-3);
    border: 1px solid var(--stroke-2);
    box-shadow: var(--shadow);
    font-weight: 600;
    animation: pop-in 0.25s both;
  }
  .shell {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: 260px 1fr;
    min-height: 100vh;
  }
  aside {
    position: sticky;
    top: 0;
    height: 100vh;
    padding: 24px 18px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    border-right: 1px solid var(--stroke);
    background: color-mix(in srgb, var(--bg) 55%, transparent);
    backdrop-filter: blur(20px);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 6px;
  }
  .word {
    font-size: 23px;
    font-weight: 800;
    letter-spacing: -0.045em;
    line-height: 1;
  }
  .ver {
    font-size: 11px;
    color: var(--faint);
    margin-top: 4px;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  nav button {
    display: flex;
    align-items: center;
    gap: 11px;
    height: 42px;
    padding: 0 12px;
    border-radius: 13px;
    border: 1px solid transparent;
    background: none;
    color: var(--muted);
    font-weight: 650;
    font-size: 14px;
    text-align: left;
    transition: all 0.15s;
  }
  nav button:hover {
    color: var(--text);
    background: var(--surface);
  }
  nav button.on {
    color: var(--text);
    background: var(--surface-2);
    border-color: var(--stroke);
  }
  nav button.on :global(svg) {
    color: var(--carrot);
  }
  .count {
    margin-left: auto;
    min-width: 22px;
    height: 20px;
    border-radius: 10px;
    padding: 0 6px;
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 800;
    background: var(--grad);
    color: #fff;
  }
  .meter {
    margin-top: auto;
    padding: 14px;
    border-radius: 18px;
    background: var(--surface);
    border: 1px solid var(--stroke);
  }
  .meter-h,
  .meter-f {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .meter-h {
    margin-bottom: 6px;
  }
  .spd {
    font-weight: 800;
    color: var(--carrot);
    font-size: 13px;
  }
  .meter-f {
    margin-top: 6px;
    font-size: 11px;
    color: var(--faint);
  }
  .privacy {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11.5px;
    color: var(--faint);
    padding: 0 6px;
  }
  main {
    padding: 34px clamp(18px, 4vw, 56px) 60px;
    max-width: 1100px;
    width: 100%;
  }
  .page-h {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 16px;
    margin-bottom: 22px;
    flex-wrap: wrap;
  }
  h1 {
    font-size: 32px;
    letter-spacing: -0.045em;
    margin: 0 0 4px;
    line-height: 1.05;
  }
  .page-h p {
    margin: 0;
  }
  .tools {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .search {
    width: 240px;
  }
  .sec {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--faint);
    margin: 26px 0 12px;
  }
  .sec span {
    color: var(--carrot);
  }
  .linkbtn {
    margin-left: auto;
    border: 0;
    background: none;
    color: var(--carrot);
    font-weight: 700;
    font-size: 12px;
    text-transform: none;
    letter-spacing: 0;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .hero-empty {
    text-align: center;
    padding: 70px 20px;
    border-radius: 26px;
    border: 1px dashed var(--stroke-2);
    background:
      repeating-radial-gradient(circle at 50% 38%, transparent 0 22px, color-mix(in srgb, var(--carrot) 5%, transparent) 22px 23px),
      var(--surface);
  }
  .hero-empty.small {
    padding: 40px;
    color: var(--faint);
  }
  .hole {
    display: inline-grid;
    place-items: center;
    width: 132px;
    height: 132px;
    border-radius: 50%;
    background: radial-gradient(circle, var(--bg) 40%, transparent 72%);
  }
  .hero-empty h2 {
    margin: 14px 0 8px;
    letter-spacing: -0.03em;
  }
  .hero-empty p {
    max-width: 520px;
    margin: 0 auto;
    color: var(--muted);
    line-height: 1.6;
  }
  .kbd-hint {
    margin-top: 18px;
    font-size: 12.5px;
    color: var(--faint);
  }
  kbd {
    font-family: 'JetBrains Mono Variable', monospace;
    font-size: 11.5px;
    padding: 2px 6px;
    border-radius: 6px;
    border: 1px solid var(--stroke-2);
    background: var(--surface-2);
    color: var(--text);
  }
  .welcome {
    max-width: 900px;
  }
  .w-hero {
    text-align: center;
    padding: 30px 0 34px;
  }
  .w-hero h1 {
    font-size: clamp(34px, 5vw, 52px);
    margin: 22px 0 12px;
  }
  .w-hero p {
    max-width: 600px;
    margin: 0 auto;
    font-size: 16px;
    color: var(--muted);
    line-height: 1.6;
  }
  .steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
  }
  .step {
    padding: 22px;
    border-radius: 22px;
    background: var(--surface);
    border: 1px solid var(--stroke);
    position: relative;
    overflow: hidden;
  }
  .step .n {
    font-size: 40px;
    font-weight: 800;
    line-height: 1;
    background: var(--grad);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    opacity: 0.9;
  }
  .step h3 {
    margin: 12px 0 6px;
    letter-spacing: -0.02em;
  }
  .step p {
    margin: 0;
    color: var(--muted);
    font-size: 13.5px;
    line-height: 1.55;
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 14px;
  }
  .facts div {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 12px;
    row-gap: 2px;
    padding: 16px 18px;
    border-radius: 18px;
    background: var(--surface);
    border: 1px solid var(--stroke);
  }
  .facts :global(svg) {
    grid-row: span 2;
    color: var(--carrot);
    margin-top: 2px;
  }
  .facts span {
    color: var(--muted);
    font-size: 13px;
  }
  .cta {
    display: flex;
    justify-content: center;
    gap: 10px;
    margin-top: 28px;
  }
  .cta .btn {
    height: 44px;
    padding: 0 20px;
    font-size: 14px;
  }
  .pin {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    margin-top: 16px;
  }
  @media (max-width: 860px) {
    .shell {
      grid-template-columns: 1fr;
    }
    aside {
      position: static;
      height: auto;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      padding: 14px 16px;
      gap: 12px;
      border-right: 0;
      border-bottom: 1px solid var(--stroke);
    }
    nav {
      flex-direction: row;
      flex-wrap: wrap;
    }
    .meter,
    .privacy {
      display: none;
    }
    .steps,
    .facts {
      grid-template-columns: 1fr;
    }
    .search {
      width: 100%;
    }
  }
</style>
