import type { CodecPreference, OutputContainer, QualityPreset } from './types';

export type Theme = 'auto' | 'dark' | 'light';

export interface SiteRule {
  host: string;
  preset: QualityPreset;
}

export interface Settings {
  preset: QualityPreset;
  codec: CodecPreference;
  container: OutputContainer;
  /** Upper bound of parallel connections per download (adaptive engine scales up to this). */
  maxConnections: number;
  /** How many downloads run at the same time. */
  maxJobs: number;
  filenameTemplate: string;
  subfolder: string;
  saveAs: boolean;
  overlay: boolean;
  notifications: boolean;
  /** Hide direct media smaller than this (KB). */
  minSizeKB: number;
  theme: Theme;
  saveSubtitles: boolean;
  siteRules: SiteRule[];
  disabledOverlayHosts: string[];
  retries: number;
}

export const DEFAULT_SETTINGS: Settings = {
  preset: 'best',
  codec: 'compatible',
  container: 'auto',
  maxConnections: 16,
  maxJobs: 3,
  filenameTemplate: '{title} [{quality}]',
  subfolder: 'Grabbit',
  saveAs: false,
  overlay: true,
  notifications: true,
  minSizeKB: 300,
  theme: 'auto',
  saveSubtitles: false,
  siteRules: [],
  disabledOverlayHosts: [],
  retries: 6,
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  try {
    const r = await chrome.storage.local.get(KEY);
    return { ...DEFAULT_SETTINGS, ...(r[KEY] ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Serialize read-modify-write cycles so rapid edits (sliders, typing) never overwrite each other.
let saveChain: Promise<unknown> = Promise.resolve();
export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = saveChain.then(async () => {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  });
  saveChain = run.catch(() => {});
  return run;
}

export function onSettingsChanged(cb: (s: Settings) => void) {
  const l = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue ?? {}) });
  };
  chrome.storage.onChanged.addListener(l);
  return () => chrome.storage.onChanged.removeListener(l);
}

export function presetForHost(s: Settings, host: string): QualityPreset {
  const rule = s.siteRules.find((r) => host === r.host || host.endsWith('.' + r.host));
  return rule?.preset ?? s.preset;
}
