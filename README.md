# Novixa-Labs website (`web/`)

Static publisher site for Novixa-Labs Android apps.

**Canonical production URL:** https://novixa-labs.vercel.app  
**Support:** bibi85259@gmail.com

## Contents

| Path | Purpose |
|---|---|
| `index.html` | Homepage / app grid |
| `legal.html` | Legal hub (Play Console policy URLs) |
| `museprompt/` | MusePrompt privacy, terms, support |
| `fourcut/` | 4CUT privacy, terms, support |
| `emoji-battery/`, `smart-tv-remote/`, `bead-12/`, `junk-journal/`, `drowsy/` | Existing app policies |
| `app-ads.txt` | AdMob authorized sellers |
| `robots.txt` / `sitemap.xml` | Crawling |
| `favicon.svg` / `site.webmanifest` | Branding |

## Deploy to Vercel (no framework)

1. Create or open a Vercel project pointing at this `web/` folder as the **Root Directory**.
2. Framework Preset: **Other** (static). Build Command: leave empty. Output Directory: `.` (or the folder that contains `index.html`).
3. Connect the custom domain or keep the default `*.vercel.app` hostname. Canonical links in HTML assume `https://novixa-labs.vercel.app`.
4. Deploy. Confirm:
   - https://novixa-labs.vercel.app/
   - https://novixa-labs.vercel.app/legal.html
   - https://novixa-labs.vercel.app/museprompt/privacy.html
   - https://novixa-labs.vercel.app/app-ads.txt
   - https://novixa-labs.vercel.app/robots.txt
   - https://novixa-labs.vercel.app/sitemap.xml

## Google Play Console URLs (MusePrompt)

- Privacy: `https://novixa-labs.vercel.app/museprompt/privacy.html`
- Terms: `https://novixa-labs.vercel.app/museprompt/terms.html`
- Support: `https://novixa-labs.vercel.app/museprompt/support.html`

## Google Play Console URLs (4CUT)

- Privacy: `https://novixa-labs.vercel.app/fourcut/privacy.html`
- Terms: `https://novixa-labs.vercel.app/fourcut/terms.html`
- Support: `https://novixa-labs.vercel.app/fourcut/support.html`

## Google Play Console URLs (Android TV Remote: Google TV)

- Privacy: `https://novixa-labs.vercel.app/smart-tv-remote/privacy.html`
- Terms: `https://novixa-labs.vercel.app/smart-tv-remote/terms.html`
- Support: `https://novixa-labs.vercel.app/smart-tv-remote/support.html`

## Local preview

Serve the folder with any static server, for example:

```bash
npx --yes serve .
```

Or open `index.html` directly in a browser (relative links work for local file checks).

## Notes

- Do not commit secrets. `app-ads.txt` only contains the public AdMob publisher authorization line.
- Existing app policy pages are preserved; 4CUT is the seventh app on the homepage and legal hub.
