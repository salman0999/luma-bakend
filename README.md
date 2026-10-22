# Luma provider backend 1.2

A TypeScript/JavaScript backend that loads Vega-compatible provider repositories, including `Zenda-Cross/vega-providers`, and exposes catalog, search, detail, episode, settings, and multiple-stream APIs to the Luma Android app.

The backend runs on your computer or server. It is **not bundled as a server inside the APK**. Your Android app connects to it using a URL and a private API token.

## Start on your computer

Install Node.js 24. Open a terminal in this `backend` folder:

```sh
npm ci
npm run build
npm run start:lan
```

Leave that terminal running. In another terminal in the same folder:

```sh
npm run pair
```

This prints your computer's LAN URL and API token for you to enter on the phone. Keep the token private. The backend creates it under `data/auth-token` on first start. If your computer has several network interfaces, use the address reachable from your phone's Wi-Fi network.

## Connect the Android app

1. Install `Luma-1.2-preview.apk` on your Android phone.
2. Connect the phone and computer to the same Wi-Fi network.
3. Open **Add media → Browse providers** (also under **Settings → Providers & backend**).
4. Enter the URL and token shown by `npm run pair`, then tap **Connect & check**.
5. Tap **Add a provider repository**. The default is `https://github.com/Zenda-Cross/vega-providers`.
6. Tap **Read repository manifest**, find **MultiStream**, and tap **Install**. You can install other providers from the same repository.
7. Browse a provider's catalogs or search across enabled providers. Select a title, season/episode if applicable, then select a server/quality.

Choosing a stream saves the title to your library. Playing it again resolves fresh links instead of relying on an expired URL. The Android player receives the selected stream's MIME hint, HTTP headers, and subtitles.

If the phone cannot connect, check the URL, token, running backend, same-network access, guest Wi-Fi isolation, and your computer's existing firewall policy for port 4317. `localhost` on your phone refers to the phone, not your computer. `npm start` binds only to localhost; use `npm run start:lan` for phone access. The service is not hosted publicly by this deliverable.

## Configuration

- `LUMA_HOST`: bind address; default `127.0.0.1`, or `0.0.0.0` through `start:lan`.
- `LUMA_PORT`: explicit port override; otherwise uses the hosting platform's `PORT`, then defaults to `4317`.
- `LUMA_DATA_DIR`: default `data` relative to the process working directory.
- `LUMA_API_TOKEN`: optional explicit token of at least 32 characters. Otherwise generated and persisted.
- `LUMA_ALLOWED_ORIGINS`: optional comma-separated browser origins. Defaults include the Android app-assets origin and the local UI preview at port 4173. Native Android requests do not use browser CORS.

For internet-hosted use, provide HTTPS through your server's reverse proxy and set a strong private token. Local HTTP pairing is intended for a trusted private network. The token authorizes provider installation, removal, and settings, so do not put it into public URLs or share it in logs.

## Docker option

For a hosted service, see [DEPLOYMENT.md](DEPLOYMENT.md). Railway build, health-check, and restart configuration is included in `railway.json`. Hosting account connection and a real deployment are still required.

The default `render.yaml` now selects Render Free for one user, with a stable environment token and automatic configured-provider restoration. Read [RENDER-FREE.md](RENDER-FREE.md) for cold starts and data-reset limits. The optional paid-disk configuration is `render-paid.yaml`; neither has been provisioned. A clean production-only dependency install was tested locally: health checks, authenticated API access, QuickJS provider search, catalogs, stream resolution, and persisted settings after restart all passed. This is a Windows production-package check, not a Docker/Linux or public-hosting test.

From the backend folder:

```sh
docker build -t luma-backend .
docker run --rm -p 4317:4317 -v luma-data:/app/data --name luma-backend luma-backend
```

In a second terminal, retrieve connection information with `docker exec luma-backend npm run pair`; use your host computer's LAN IP rather than the container's internal IP. The Dockerfile is supplied but was not built or run in this environment.

## Provider execution

- Repositories use Vega's `manifest.json` and `dist/<provider>/catalog.js`, `posts.js`, `meta.js`, and `stream.js`. `episodes.js` and `settings.js` are optional.
- Installations are pinned to a full Git commit and hashed per module. They do not silently update. Refresh/re-add the repository and reinstall a provider when you want a newer revision.
- Provider JavaScript runs inside a **QuickJS WebAssembly interpreter in a worker**, not Node `eval` or `vm`. It cannot import Node modules, inspect the server environment, or read files.
- Each operation has a wall-clock deadline, a 96 MB QuickJS heap limit, a worker watchdog, bounded network requests, response-size limits, and scoped persistent KV storage. `LUMA_MAX_WORKERS` sets the worker limit from 1 to 6 (default 6; Render Free uses 1). A bounded queue waits up to 10 seconds for capacity; searches include up to the first 12 enabled providers, fan out to three providers at a time, and preserve partial results. Disable unused providers to keep the active search set focused.
- The provider context includes axios-style requests, bundled Cheerio, common headers, scoped KV, fetch, timers, URL helpers, base64, UTF-8 helpers, and digest/random helpers.
- Outbound requests reject loopback/private/reserved IPs, including mapped IPv6 addresses; DNS results are checked in the connection lookup and redirects are revalidated. Cross-origin redirects strip cookies and authorization.
- Authenticated API responses are not cached by browsers. Catalog/search and metadata results have short in-memory caches; resolved streams cache for 15 seconds. A player refresh request with `refresh: true` bypasses and invalidates that cached result.

## Compatibility limits

Vega is a larger runtime. Providers that require an interactive WebView, browser challenges, native mobile integrations, unsupported external imports, DRM, torrents, or application-specific APIs are not guaranteed to work. `openWebView` returns an explicit unsupported-operation error. Provider-reported errors are surfaced as warnings; an empty list is not a guarantee that a title has no sources.

Stream availability depends on the third-party provider and its upstream servers. The backend does not bypass login, DRM, or browser verification. Its own built-in **Luma Open Films** provider can be used to check the full connection and stream-picker workflow without installing a third-party provider.

## API

All `/api` endpoints require `Authorization: Bearer <token>`. `GET /health` is a minimal unauthenticated health check.

- `GET /api/status`: sources and installed provider summaries, without stored KV secrets.
- `POST /api/sources` with `{ "url": "https://github.com/owner/repo" }`: read and pin a manifest.
- `GET /api/sources/:id/manifest`: inspect available providers.
- `POST /api/plugins/install` with `{ "sourceId": "...", "value": "autoEmbed" }`.
- `PATCH /api/plugins/:id` with `{ "enabled": true }` or `{ "settings": { ... } }`.
- `DELETE /api/plugins/:id`: uninstall provider code and settings.
- `GET /api/providers/:id/catalog`.
- `POST /api/providers/:id/posts` with `{ "filter": "...", "page": 1 }`.
- `POST /api/search` with `{ "query": "...", "providerIds": ["..."] }`; provider IDs are optional.
- `POST /api/providers/:id/meta` with `{ "link": "..." }`.
- `POST /api/providers/:id/episodes` with `{ "url": "..." }`.
- `POST /api/providers/:id/streams` with `{ "link": "...", "type": "movie", "refresh": false }`.
- `GET /api/providers/:id/settings`: schema and authenticated settings values.

## Verification

Run `npm run check` and `npm test`.

Automated tests cover the API, authentication/origin checks, provider isolation, CPU interruption, HTTP/Cheerio/KV compatibility, persistent revisions/settings, integrity rejection, partial provider failure, and stream normalization. Android UI tests additionally cover connection → catalog → details → stream picker → native playback handoff with headers and subtitles.

The live Zenda Cross manifest was read, MultiStream 3.6 was installed at a pinned revision, and its real catalog, settings, and search modules executed successfully. This does not establish that every provider or upstream playback server works. Android phone playback still needs device testing. No Docker deployment, public hosting, or speed comparison with Vega was performed.

Third-party provider source is fetched only when installed and is intentionally excluded from the distributed source ZIP, along with tokens, settings, and runtime data.
