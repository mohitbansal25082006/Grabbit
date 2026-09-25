// Reactive stores shared by the popup and the hub.
import { bg, onBroadcast } from '@/lib/messaging';
import { DEFAULT_SETTINGS, getSettings, onSettingsChanged, saveSettings, type Settings, type Theme } from '@/lib/settings';
import type { Job } from '@/lib/types';

export function createJobs() {
  const state = $state({ list: [] as Job[], loaded: false, error: '' });
  const upsert = (job: Job) => {
    const i = state.list.findIndex((j) => j.id === job.id);
    if (i >= 0) state.list[i] = job;
    else state.list = [job, ...state.list];
  };
  const refresh = async () => {
    try {
      state.list = await bg<Job[]>('jobs.list');
      state.error = '';
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.loaded = true;
    }
  };
  const off = onBroadcast((m) => {
    if (m.type === 'job') upsert(m.job);
    else if (m.type === 'job-removed') state.list = state.list.filter((j) => j.id !== m.id);
  });
  void refresh();
  return {
    get list() {
      return state.list;
    },
    get loaded() {
      return state.loaded;
    },
    get error() {
      return state.error;
    },
    refresh,
    action: (id: string, action: string) => bg('job.action', { id, action }),
    clear: () => bg('jobs.clear'),
    destroy: off,
  };
}

export function createSettings() {
  const state = $state({ value: { ...DEFAULT_SETTINGS } as Settings, loaded: false });
  void getSettings().then((s) => {
    state.value = s;
    state.loaded = true;
    applyTheme(s.theme);
  });
  const off = onSettingsChanged((s) => {
    state.value = s;
    applyTheme(s.theme);
  });
  return {
    get value() {
      return state.value;
    },
    get loaded() {
      return state.loaded;
    },
    async set(patch: Partial<Settings>) {
      state.value = { ...state.value, ...patch };
      if (patch.theme) applyTheme(patch.theme);
      await saveSettings(patch);
    },
    destroy: off,
  };
}

let mql: MediaQueryList | undefined;
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const resolve = () => {
    const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'dark' : 'light';
  };
  resolve();
  mql ??= window.matchMedia('(prefers-color-scheme: dark)');
  mql.onchange = theme === 'auto' ? resolve : null;
}

/**
 * Open / reveal a finished download. Must be called straight from a click handler:
 * chrome.downloads.open() requires a user gesture, which doesn't survive messaging.
 */
export async function fileAction(job: Job | undefined, action: 'open' | 'show'): Promise<void> {
  if (!job || job.downloadId == null) {
    chrome.downloads.showDefaultFolder();
    return;
  }
  const id = job.downloadId;
  const [d] = await chrome.downloads.search({ id });
  if (!d || d.exists === false || d.state !== 'complete') throw new Error('The file was moved or deleted from your Downloads folder.');
  if (action === 'open') {
    try {
      await chrome.downloads.open(id);
      return;
    } catch {
      /* e.g. no app registered for the file type → reveal it instead */
    }
  }
  chrome.downloads.show(id);
}
