# Backstage — Cloudflare setup

Two parts, both on Cloudflare:

| Folder | What it is | Cloudflare product |
|---|---|---|
| `backstage/` | The app (photos, outfits, calendar). Data stays on the user's phone. | **Pages** (static hosting) |
| `backstage-api/` | Small API that holds your Anthropic key and asks Claude for outfit ideas. | **Workers** |

## 1. Deploy the API (Worker)

You need a Cloudflare account and an Anthropic API key (console.anthropic.com).

```bash
cd backstage-api
npm install
npx wrangler login                       # opens the browser once
npx wrangler secret put ANTHROPIC_API_KEY  # paste your key when asked
npx wrangler deploy
```

Wrangler prints the address, e.g. `https://backstage-api.<your-subdomain>.workers.dev`.
Open it in a browser — you should see `{"ok":true,...}`.

## 2. Point the app at the API

Edit `backstage/config.js`:

```js
window.BACKSTAGE_CONFIG = { apiUrl: "https://backstage-api.<your-subdomain>.workers.dev" };
```

## 3. Host the app (Pages)

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick this repo.

- Framework preset: **None**
- Build command: *(leave empty)*
- Build output directory: `/`

The app is then at `https://<project>.pages.dev/backstage/`. (It also works on the existing GitHub Pages site at `/backstage/`.)

## 4. Allow your site to call the API

In `backstage-api/wrangler.toml`, add your Pages address to `ALLOWED_ORIGINS` (comma-separated), then `npx wrangler deploy` again.

## Settings (`backstage-api/wrangler.toml`)

- `MODEL` — Claude model used for suggestions (default `claude-opus-5-5`). You can switch to a cheaper model such as `claude-sonnet-5-5` or `claude-haiku-4-5` if cost matters more than quality.
- `EFFORT` — how hard the model thinks (`low` keeps answers fast and cheap).

## Protect your bill

The origin check stops other websites from using your API in a browser, but a script could still call it directly. Before sharing widely:

- Set a monthly **spend limit** in the Anthropic Console.
- Add a **rate limiting rule** for the Worker in the Cloudflare dashboard (Security → WAF → Rate limiting rules).

## Local development

```bash
cd backstage-api
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars   # git-ignored
npx wrangler dev                                  # API on http://localhost:8787
# in another terminal, from the repo root:
python3 -m http.server 8788                       # app on http://localhost:8788/backstage/
```
Set `apiUrl` to `http://localhost:8787` while testing (don't commit that).
