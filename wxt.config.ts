import { defineConfig } from 'wxt';

// Grabbit — built for every Chromium browser (Chrome, Edge, Brave, Opera, Vivaldi).
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  imports: false,
  manifestVersion: 3,
  manifest: {
    name: 'Grabbit — Video Downloader',
    short_name: 'Grabbit',
    description:
      'Grab web videos in the best available quality. Parallel turbo downloads for HLS, DASH, MP4 & WebM with full quality control.',
    minimum_chrome_version: '116',
    homepage_url: 'https://github.com/mohitbansal25082006/Grabbit',
    permissions: [
      'webRequest',
      'declarativeNetRequestWithHostAccess',
      'downloads',
      'downloads.open',
      'offscreen',
      'storage',
      'unlimitedStorage',
      'contextMenus',
      'notifications',
      'scripting',
    ],
    host_permissions: ['<all_urls>'],
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: {
      default_title: 'Grabbit',
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+V' },
        description: 'Open Grabbit',
      },
      'grab-best': {
        suggested_key: { default: 'Alt+Shift+G' },
        description: 'Grab the best video on this page',
      },
    },
    web_accessible_resources: [
      { resources: ['recorder.html', 'chunks/*', 'assets/*'], matches: ['<all_urls>'] },
    ],
  },
});
