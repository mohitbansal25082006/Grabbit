# Chrome Web Store — Complete Submission Kit for Grabbit

Everything you need to publish, in the order the Developer Dashboard asks for it. Copy each block into the matching field.

**Files in this folder**

| File | Upload to |
|---|---|
| `grabbit-1.0.0-chrome.zip` | **Package** (the extension itself) |
| `icon-128.png` | Store listing → **Store icon** (128×128) |
| `screenshots/01-quality-dial.png` … `05-settings.png` | Store listing → **Screenshots** (1280×800, upload in order) |
| `promo-small-440x280.png` | Store listing → **Small promo tile** |
| `promo-marquee-1400x560.png` | Store listing → **Marquee promo tile** |
| `../PRIVACY.md` | Host it and paste its URL as the **Privacy policy URL** |

To regenerate the assets after UI changes: `npm run build && npm run fixtures && npm run store`, then rebuild the package with `npm run zip` (output: `.output/grabbit-1.0.0-chrome.zip`).

---

## Step 0 — One-time setup

1. Go to https://chrome.google.com/webstore/devconsole and sign in with the Google account you want to publish under.
2. Pay the one-time **US$5 developer registration fee** and accept the developer agreement.
3. **Account** tab: set your publisher/display name and a contact email, and **verify the email** (publishing is blocked until it is verified).
4. Make the privacy policy reachable by URL (pick one):
   - Make this GitHub repository public and use
     `https://github.com/mohitbansal25082006/Grabbit/blob/main/PRIVACY.md` (after merging to `main`), or
   - Enable GitHub Pages / any web host and publish `PRIVACY.md` there.

## Step 1 — Upload the package

Dashboard → **Items** → **+ New item** → upload `store/grabbit-1.0.0-chrome.zip`.

---

## Step 2 — Store listing tab

### Product details

**Title** (from the manifest, not editable here)
```
Grabbit — Video Downloader
```

**Summary** (from the manifest, 124/132 characters)
```
Grab web videos in the best available quality. Parallel turbo downloads for HLS, DASH, MP4 & WebM with full quality control.
```

**Description**
```
Grabbit finds the videos on the page you're watching and saves them in the quality you choose — fast.

🎛 TURN THE DIAL, PICK ANY QUALITY
• Every stream on the page shows up as a card with its available qualities: 4K, 1440p, 1080p, 720p, 480p… or audio only.
• The Quality Dial shows codec, frame rate, HDR and a live file-size estimate before you download.
• Choose the audio track and subtitles (saved as .srt), and save as MP4, MKV or the original format.
• Set a default quality, prefer the most compatible (H.264) or most efficient codec, and add per-site quality rules.

⚡ TURBO DOWNLOADS
• Every download is split into parallel lanes (up to 32 connections) that adapt to your network in real time — adding lanes while speed improves and backing off if a server slows down.
• Pause and resume anytime, even after restarting the browser. Finished pieces are never downloaded twice.
• Automatic retries and smart recovery keep long downloads going.
• Separate video and audio streams are merged into one file losslessly — no re-encoding, no quality loss.
• Large files are written straight to disk, so multi-GB downloads don't fill your memory.

🔎 FINDS THE STREAMS OTHERS MISS
• Detects HLS (.m3u8), MPEG-DASH (.mpd), MP4, WebM, MKV, MOV, MP3, M4A and more.
• Catches streams loaded through a site's own player code and embedded players inside frames.
• Groups different sizes of the same video into one card, and filters out ads, previews and tiny clips.
• Record while playing: for players that hide their video links, Grabbit can record exactly what plays (optional Turbo 8× to finish long videos quickly) and save it as one clean file.
• Live HLS streams can be recorded with one-click Stop & Save.

🐇 A DOWNLOADER THAT'S A JOY TO USE
• Hover any video and press the "Grab" button right on the page.
• The Downloads page shows live speed, the number of active lanes, ETA and a segment map where you can watch every piece land.
• Right-click menu: "Grab this video", "Grab audio only", "Grab linked media".
• Keyboard shortcuts: Alt+Shift+G grabs the best video on the page, Alt+Shift+V opens Grabbit.
• Beautiful dark "Burrow Neon" theme and a light theme.

🔒 PRIVATE BY DESIGN
• Everything runs locally in your browser. No accounts, no tracking, no analytics, no ads.
• Grabbit only talks to the website that hosts the video you choose to download.

GOOD TO KNOW
• Grabbit respects content protection: it does not download DRM-protected videos (for example from paid streaming services), and it does not work on YouTube.
• Please only download videos you own or have permission to save, and respect each website's terms and creators' rights.

Built for Chrome, Microsoft Edge, Brave and other Chromium-based browsers.
```

**Category**
```
Productivity → Tools
```
(If the dashboard shows the older flat list, choose **Productivity**.)

**Language**
```
English (United States)
```

### Graphic assets
- **Store icon:** `icon-128.png`
- **Global promo video:** leave empty (optional)
- **Screenshots** (upload in this order):
  1. `screenshots/01-quality-dial.png`
  2. `screenshots/02-turbo-downloads.png`
  3. `screenshots/03-in-page-button.png`
  4. `screenshots/04-record-while-playing.png`
  5. `screenshots/05-settings.png`
- **Small promo tile:** `promo-small-440x280.png`
- **Marquee promo tile:** `promo-marquee-1400x560.png`

### Additional fields
- **Official URL:** leave empty (needs a Search Console-verified domain), or pick your verified site.
- **Homepage URL:** `https://github.com/mohitbansal25082006/Grabbit`
- **Support URL:** `https://github.com/mohitbansal25082006/Grabbit/issues`
- **Mature content:** No

---

## Step 3 — Privacy practices tab

### Single purpose
```
Grabbit has a single purpose: to detect video and audio media on the web pages the user visits and download it to the user's computer in the quality the user chooses. All of its features — stream detection, the quality picker, the parallel download engine, lossless merging of audio and video, pause/resume, the in-page Grab button and "record while playing" — exist only to serve that one purpose.
```

### Permission justifications

**webRequest**
```
Used in observe-only mode to notice media requests (HLS/DASH manifests and video/audio files) and their content type and size as pages load them. This is how Grabbit detects downloadable videos. Requests are never blocked or modified through this permission, and nothing is stored beyond the current tab session.
```

**declarativeNetRequestWithHostAccess**
```
Many video servers only answer requests that carry the same Referer/Origin headers the page's own player sends. When the user starts a download, Grabbit adds a temporary session rule that sets those headers only for the extension's own download requests to that video's servers, and removes the rule when the download ends. Page traffic is never modified.
```

**downloads**
```
Saves the finished video/audio file to the user's Downloads folder and shows it in the folder when the user clicks "Show in folder".
```

**downloads.open**
```
Lets the user open a finished video directly from Grabbit's Downloads page by clicking its "Open file" (play) button.
```

**offscreen**
```
Runs the download engine in an offscreen document. It needs Web Workers and file (Blob) URLs, which service workers don't provide, to download streams in parallel, merge audio and video, and hand the finished file to chrome.downloads.
```

**storage**
```
Stores the user's settings (default quality, file name template, speed limits, theme…) and the list of media detected in each tab for the popup.
```

**unlimitedStorage**
```
Videos are assembled on disk in the extension's private storage (Origin Private File System) before being saved. Multi-gigabyte videos would exceed the default quota; the data is deleted as soon as the file is saved to the Downloads folder.
```

**contextMenus**
```
Adds "Grab this video", "Grab audio only" and "Grab linked media" to the right-click menu on videos and media links.
```

**notifications**
```
Tells the user when a download has finished or failed (can be turned off in Settings).
```

**scripting**
```
Right after installation, injects Grabbit's detection script into tabs that were already open, so videos on those pages can be detected without reloading every tab.
```

**Host permission (<all_urls>)**
```
Videos can be hosted on any website and are usually served from separate CDN domains, so Grabbit needs host access to: (1) detect media requests on the page the user is viewing, (2) run its content script that finds <video> elements and shows the in-page "Grab" button, and (3) download the chosen media and its segments from whatever server hosts them. Grabbit only contacts the servers of the media the user chooses to download. It does not run on YouTube.
```

### Remote code
```
No, I am not using remote code.
```
(All JavaScript and WebAssembly is bundled in the package. Grabbit never loads or evaluates code from the network.)

### Data usage
Tick **none** of the data-type boxes — Grabbit does not collect or transmit any user data. (Detected page/media URLs, headers and download history are processed only locally and never leave the browser; see PRIVACY.md.)

Then tick all three certifications:
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL
```
https://github.com/mohitbansal25082006/Grabbit/blob/main/PRIVACY.md
```
(Use your hosted URL if you publish it elsewhere — the page must be publicly reachable.)

---

## Step 4 — Test instructions tab

**Test instructions** (no account needed)
```
No login or account is required.

1. Open a page with a public test stream, e.g. the Apple HLS example:
   https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
   (or any page with an HTML5 video such as https://test-videos.co.uk/bigbuckbunny/mp4-h264).
2. Click the Grabbit toolbar icon. The detected video appears as a card; expand it to see the Quality Dial.
3. Turn the dial to choose a quality and click "Grab". Progress appears in the popup and in the Downloads page (inbox icon), and the file is saved to Downloads/Grabbit/.
4. Alternatively, open the popup on any page → "More ways to grab" → paste a stream URL such as
   https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd and press Enter, then Grab.
5. Hover a video on a page to see the in-page "Grab" button.
Grabbit intentionally does not work on YouTube and does not download DRM-protected content.
```

---

## Step 5 — Distribution tab
- **Payments:** Free of charge
- **Visibility:** Public (or **Unlisted** for a soft launch; switch to Public later)
- **Distribution:** All regions

## Step 6 — Submit
Click **Submit for review**. Choose whether to publish automatically after approval.

Reviews for extensions with broad host permissions and `webRequest` usually take a few days (sometimes longer for a first submission). If the reviewer asks questions, reply using the justifications above.

---

## Updating later
1. Bump `version` in `package.json` (e.g. `1.0.1`).
2. `npm run zip` → upload the new `.output/grabbit-<version>-chrome.zip` on the item's **Package** tab → **Submit for review**.

## Also publishing on Microsoft Edge Add-ons? (optional, free)
The same ZIP works. Go to https://partner.microsoft.com/dashboard/microsoftedge → create a new extension → upload `grabbit-1.0.0-chrome.zip`, then reuse the description, screenshots, promo tile (use the 440×280 tile; Edge also accepts 1400×560) and privacy policy URL from this document.

## Pre-submission checklist
- [x] Manifest V3, version 1.0.0, minimum Chrome 116
- [x] No remote code, no eval, no analytics
- [x] Every permission used and justified above
- [x] YouTube excluded, DRM-protected content refused
- [x] Store icon 128×128, 5 screenshots 1280×800, small tile 440×280, marquee 1400×560
- [x] Privacy policy written (`PRIVACY.md`)
- [ ] Developer account registered and email verified
- [ ] Privacy policy publicly reachable at the URL you enter
