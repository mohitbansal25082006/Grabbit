<script lang="ts">
  import type { Settings, SiteRule } from '@/lib/settings';
  import type { QualityPreset } from '@/lib/types';
  import { renderTemplate, sanitizePath } from '@/lib/util';
  import Icon from './Icon.svelte';

  let { value, onchange }: { value: Settings; onchange: (patch: Partial<Settings>) => void } = $props();

  const PRESETS: [QualityPreset, string][] = [
    ['best', 'Best'],
    ['2160', '4K'],
    ['1440', '1440p'],
    ['1080', '1080p'],
    ['720', '720p'],
    ['480', '480p'],
    ['smallest', 'Smallest'],
    ['audio', 'Audio'],
  ];

  let newHost = $state('');
  let newPreset = $state<QualityPreset>('1080');
  let newOverlayHost = $state('');

  const preview = $derived(
    `${value.subfolder ? sanitizePath(value.subfolder) + '/' : ''}${renderTemplate(value.filenameTemplate || '{title}', { title: 'Northern Lights Timelapse', site: 'vimeo.com', quality: '1080p' })}.mp4`,
  );

  function addRule() {
    const host = newHost.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!host) return;
    const rules: SiteRule[] = [...value.siteRules.filter((r) => r.host !== host), { host, preset: newPreset }];
    onchange({ siteRules: rules });
    newHost = '';
  }
  function addOverlayHost() {
    const host = newOverlayHost.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!host) return;
    onchange({ disabledOverlayHosts: [...new Set([...value.disabledOverlayHosts, host])] });
    newOverlayHost = '';
  }
  const tokens = ['{title}', '{quality}', '{site}', '{date}', '{time}'];
</script>

<div class="settings">
  <section class="card">
    <header><span class="ic"><Icon name="sparkle" /></span><div><h3>Quality</h3><p>What “Grab” picks by default. You can always turn the dial.</p></div></header>
    <div class="field">
      <span class="label">Default quality</span>
      <div class="pills">
        {#each PRESETS as [v, l]}
          <button class="pill" class:on={value.preset === v} onclick={() => onchange({ preset: v })}>{l}</button>
        {/each}
      </div>
    </div>
    <div class="field">
      <span class="label">When several codecs exist at the same resolution</span>
      <div class="pills">
        <button class="pill" class:on={value.codec === 'compatible'} onclick={() => onchange({ codec: 'compatible' })}>Most compatible (H.264)</button>
        <button class="pill" class:on={value.codec === 'quality'} onclick={() => onchange({ codec: 'quality' })}>Most efficient (AV1 / VP9 / HEVC)</button>
      </div>
    </div>
  </section>

  <section class="card">
    <header><span class="ic"><Icon name="film" /></span><div><h3>Output</h3><p>Streams are remuxed losslessly — never re-encoded.</p></div></header>
    <div class="field">
      <span class="label">Container</span>
      <div class="pills">
        {#each [['auto', 'Auto (MP4, MKV if needed)'], ['mp4', 'MP4'], ['mkv', 'MKV'], ['original', 'Keep original (.ts / raw)']] as [v, l]}
          <button class="pill" class:on={value.container === v} onclick={() => onchange({ container: v as Settings['container'] })}>{l}</button>
        {/each}
      </div>
    </div>
    <div class="grid2">
      <label class="field">
        <span class="label">File name template</span>
        <input class="input mono" value={value.filenameTemplate} onchange={(e) => onchange({ filenameTemplate: e.currentTarget.value })} />
        <div class="tokens">
          {#each tokens as t}<button class="tok mono" onclick={() => onchange({ filenameTemplate: `${value.filenameTemplate} ${t}`.trim() })}>{t}</button>{/each}
        </div>
      </label>
      <label class="field">
        <span class="label">Subfolder in Downloads</span>
        <input class="input" value={value.subfolder} placeholder="(none)" onchange={(e) => onchange({ subfolder: e.currentTarget.value })} />
      </label>
    </div>
    <div class="preview"><Icon name="folder" size={15} /><span class="mono ellipsis">Downloads/{preview}</span></div>
    <label class="switch-row">
      <div><b>Ask where to save each file</b><span>Show the browser’s Save dialog for every download.</span></div>
      <input type="checkbox" class="switch" checked={value.saveAs} onchange={(e) => onchange({ saveAs: e.currentTarget.checked })} />
    </label>
    <label class="switch-row">
      <div><b>Save subtitles by default</b><span>Downloads a matching subtitle track as .srt next to the video.</span></div>
      <input type="checkbox" class="switch" checked={value.saveSubtitles} onchange={(e) => onchange({ saveSubtitles: e.currentTarget.checked })} />
    </label>
  </section>

  <section class="card">
    <header><span class="ic"><Icon name="bolt" /></span><div><h3>Speed engine</h3><p>Grabbit opens parallel connections and adapts them live to your network — like TCP congestion control.</p></div></header>
    <div class="field">
      <div class="lbl-row"><span class="label">Max connections per download</span><span class="val mono">{value.maxConnections}</span></div>
      <input type="range" min="1" max="32" value={value.maxConnections} oninput={(e) => onchange({ maxConnections: +e.currentTarget.value })} style="--p:{((value.maxConnections - 1) / 31) * 100}%" />
      <div class="hint">16 is a great default. Lower it if a site starts rate-limiting (HTTP 429).</div>
    </div>
    <div class="grid2">
      <div class="field">
        <div class="lbl-row"><span class="label">Downloads at once</span><span class="val mono">{value.maxJobs}</span></div>
        <input type="range" min="1" max="6" value={value.maxJobs} oninput={(e) => onchange({ maxJobs: +e.currentTarget.value })} style="--p:{((value.maxJobs - 1) / 5) * 100}%" />
      </div>
      <div class="field">
        <div class="lbl-row"><span class="label">Retries per chunk</span><span class="val mono">{value.retries}</span></div>
        <input type="range" min="1" max="12" value={value.retries} oninput={(e) => onchange({ retries: +e.currentTarget.value })} style="--p:{((value.retries - 1) / 11) * 100}%" />
      </div>
    </div>
  </section>

  <section class="card">
    <header><span class="ic"><Icon name="radar" /></span><div><h3>Detection & page button</h3><p>How Grabbit shows up on websites.</p></div></header>
    <label class="switch-row">
      <div><b>Show the “Grab” button on videos</b><span>A small pill appears when you hover over a video.</span></div>
      <input type="checkbox" class="switch" checked={value.overlay} onchange={(e) => onchange({ overlay: e.currentTarget.checked })} />
    </label>
    <div class="field">
      <span class="label">Hide the page button on these sites</span>
      <div class="add">
        <input class="input" placeholder="example.com" bind:value={newOverlayHost} onkeydown={(e) => e.key === 'Enter' && addOverlayHost()} />
        <button class="btn" onclick={addOverlayHost}><Icon name="plus" size={15} /> Add</button>
      </div>
      {#if value.disabledOverlayHosts.length}
        <div class="tags">
          {#each value.disabledOverlayHosts as h}
            <span class="tag">{h}<button aria-label="Remove {h}" onclick={() => onchange({ disabledOverlayHosts: value.disabledOverlayHosts.filter((x) => x !== h) })}><Icon name="x" size={12} /></button></span>
          {/each}
        </div>
      {/if}
    </div>
    <div class="field">
      <div class="lbl-row"><span class="label">Ignore files smaller than</span><span class="val mono">{value.minSizeKB >= 1024 ? `${(value.minSizeKB / 1024).toFixed(1)} MB` : `${value.minSizeKB} KB`}</span></div>
      <input type="range" min="0" max="5120" step="64" value={value.minSizeKB} oninput={(e) => onchange({ minSizeKB: +e.currentTarget.value })} style="--p:{(value.minSizeKB / 5120) * 100}%" />
    </div>
  </section>

  <section class="card">
    <header><span class="ic"><Icon name="globe" /></span><div><h3>Per-site quality</h3><p>Override the default quality on specific sites.</p></div></header>
    <div class="add">
      <input class="input" placeholder="site.com" bind:value={newHost} onkeydown={(e) => e.key === 'Enter' && addRule()} />
      <select class="input" bind:value={newPreset} style="max-width:130px">
        {#each PRESETS as [v, l]}<option value={v}>{l}</option>{/each}
      </select>
      <button class="btn" onclick={addRule}><Icon name="plus" size={15} /> Add</button>
    </div>
    {#if value.siteRules.length}
      <div class="rules">
        {#each value.siteRules as r}
          <div class="rule">
            <Icon name="globe" size={14} /><span class="ellipsis">{r.host}</span><span class="chip hot">{PRESETS.find((p) => p[0] === r.preset)?.[1]}</span>
            <button class="btn sm icon ghost danger" aria-label="Remove rule" onclick={() => onchange({ siteRules: value.siteRules.filter((x) => x.host !== r.host) })}><Icon name="trash" size={14} /></button>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="card">
    <header><span class="ic"><Icon name="sun" /></span><div><h3>Appearance & notifications</h3><p>Make it yours.</p></div></header>
    <div class="field">
      <span class="label">Theme</span>
      <div class="pills">
        {#each [['auto', 'System'], ['dark', 'Night burrow'], ['light', 'Daylight meadow']] as [v, l]}
          <button class="pill" class:on={value.theme === v} onclick={() => onchange({ theme: v as Settings['theme'] })}>{l}</button>
        {/each}
      </div>
    </div>
    <label class="switch-row">
      <div><b>Desktop notifications</b><span>Tell me when a download finishes or fails.</span></div>
      <input type="checkbox" class="switch" checked={value.notifications} onchange={(e) => onchange({ notifications: e.currentTarget.checked })} />
    </label>
    <div class="switch-row">
      <div><b>Keyboard shortcuts</b><span><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> grabs the best video · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> opens Grabbit</span></div>
      <button class="btn sm" onclick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}><Icon name="keyboard" size={14} /> Customize</button>
    </div>
  </section>
</div>

<style>
  .settings {
    display: grid;
    gap: 16px;
    max-width: 820px;
  }
  .card {
    padding: 20px 22px;
    border-radius: 22px;
    background: var(--surface);
    border: 1px solid var(--stroke);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  header {
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .ic {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: var(--grad-soft);
    color: var(--carrot);
    flex-shrink: 0;
  }
  h3 {
    margin: 2px 0 2px;
    font-size: 16px;
    letter-spacing: -0.02em;
  }
  header p {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pill {
    height: 32px;
    padding: 0 13px;
    border-radius: 10px;
    border: 1px solid var(--stroke);
    background: var(--surface);
    font-size: 12.5px;
    font-weight: 650;
    color: var(--muted);
    transition: all 0.15s;
  }
  .pill:hover {
    color: var(--text);
    border-color: var(--stroke-2);
  }
  .pill.on {
    color: var(--text);
    background: var(--grad-soft);
    border-color: color-mix(in srgb, var(--carrot) 55%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--carrot) 25%, transparent);
  }
  .tokens {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
  }
  .tok {
    font-size: 11px;
    padding: 3px 7px;
    border-radius: 7px;
    border: 1px dashed var(--stroke-2);
    background: none;
    color: var(--muted);
  }
  .tok:hover {
    color: var(--carrot);
    border-color: var(--carrot);
  }
  .preview {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--bg-2);
    border: 1px solid var(--stroke);
    color: var(--muted);
    font-size: 12px;
    min-width: 0;
  }
  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--stroke);
    cursor: pointer;
  }
  .switch-row div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .switch-row b {
    font-size: 13.5px;
    font-weight: 650;
  }
  .switch-row span {
    font-size: 12.5px;
    color: var(--muted);
  }
  kbd {
    font-family: 'JetBrains Mono Variable', monospace;
    font-size: 11px;
    padding: 1px 5px;
    border-radius: 5px;
    border: 1px solid var(--stroke-2);
    background: var(--surface-2);
  }
  .switch {
    appearance: none;
    width: 40px;
    height: 23px;
    border-radius: 99px;
    background: var(--surface-3);
    position: relative;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
    margin: 0;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    transition: transform 0.25s cubic-bezier(0.3, 1.5, 0.5, 1);
  }
  .switch:checked {
    background: var(--grad);
  }
  .switch:checked::after {
    transform: translateX(17px);
  }
  .lbl-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .val {
    font-weight: 800;
    color: var(--carrot);
    font-size: 13px;
  }
  .hint {
    font-size: 12px;
    color: var(--faint);
  }
  input[type='range'] {
    appearance: none;
    width: 100%;
    height: 6px;
    border-radius: 99px;
    background: linear-gradient(90deg, var(--carrot) 0 var(--p), var(--surface-3) var(--p) 100%);
    outline: none;
  }
  input[type='range']::-webkit-slider-thumb {
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    border: 4px solid var(--carrot);
    box-shadow: 0 2px 10px -2px color-mix(in srgb, var(--carrot) 80%, transparent);
    cursor: grab;
  }
  .add {
    display: flex;
    gap: 8px;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 4px 3px 10px;
    border-radius: 99px;
    background: var(--surface-2);
    border: 1px solid var(--stroke);
    font-size: 12px;
  }
  .tag button {
    border: 0;
    background: none;
    color: var(--faint);
    display: grid;
    padding: 3px;
    border-radius: 50%;
  }
  .tag button:hover {
    color: var(--danger);
  }
  .rules {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rule {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 6px 6px 12px;
    border-radius: 12px;
    background: var(--bg-2);
    border: 1px solid var(--stroke);
    font-size: 13px;
  }
  .rule .ellipsis {
    flex: 1;
  }
  @media (max-width: 720px) {
    .grid2 {
      grid-template-columns: 1fr;
    }
    .card {
      padding: 16px;
    }
  }
</style>
