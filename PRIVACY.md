# Grabbit — Privacy Policy

_Last updated: September 25, 2026_

Grabbit is a browser extension that detects video and audio on the web pages you visit and saves them to your computer when you ask it to. This policy explains what data Grabbit handles and how.

## The short version

**Grabbit does not collect, store on any server, sell, or share any of your data.** It has no accounts, no analytics, no tracking, no ads and no remote code. Everything happens locally inside your browser.

## What Grabbit processes (locally only)

To do its job, Grabbit processes the following **on your device only**:

| Data | Why | Where it stays |
|---|---|---|
| Addresses (URLs) and response types of media requests made by the pages you visit | To detect downloadable video/audio streams (HLS, DASH, MP4, WebM…) | In your browser's session memory for that tab; cleared when the tab navigates or closes |
| Page title, preview image (e.g. `og:image`) and a small thumbnail of a playing video | To show you which video you're downloading | Session memory for that tab |
| Request headers the page itself used for a media file (e.g. `Referer`, `Origin`, `Authorization`) | Some video servers only answer requests that look like they come from the page's player; Grabbit replays these headers **only to the same server** for the download you started | In memory for the duration of the download |
| Your download history (title, site, quality, file name, size) | So the Downloads page can show progress and past downloads | Your browser's local extension storage (IndexedDB); you can clear it anytime from **History → Clear** |
| Your settings | To remember your preferences | Your browser's local extension storage |
| Downloaded media data | Temporarily held while downloading and merging | The browser's private extension storage, deleted as soon as the file is saved to your Downloads folder |

None of this data is ever sent to the developer or to any third party. Network requests made by Grabbit go **only** to the websites and media servers that host the video you chose to download.

## What Grabbit does not do

- It does not collect personally identifiable information, health, financial, authentication, location or communication data.
- It does not track your browsing history or send it anywhere.
- It does not use cookies or trackers of its own.
- It does not sell or transfer user data to third parties, or use it for advertising, credit-worthiness or any purpose unrelated to its single feature.
- It does not download DRM-protected content and does not work on YouTube.

## Permissions

Every permission Grabbit requests is used only for its single purpose — detecting and downloading media you choose. See the permission list in the Chrome Web Store listing for details.

## Your control

- Clear your download history at any time from **Grabbit → History → Clear**.
- Removing the extension deletes all of its local data.

## Responsible use

Only download content you own or have permission to save, and respect each website's terms of service and creators' rights.

## Contact

Questions about this policy: open an issue at https://github.com/mohitbansal25082006/Grabbit/issues
