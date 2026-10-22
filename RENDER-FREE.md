# Luma: single-user Render Free backend

Status: built and tested locally, not deployed. Requires a connected Render account and a source repository accessible to that account. This configuration creates no paid disk or paid compute service.

The default `render.yaml` now selects Render Free. It uses Node 24, one instance, one provider worker at a time, HTTPS through Render, and an API token generated in Render environment settings. That token survives container filesystem resets. In the Android app, pair using the service URL and token from Render; do not publish the token or put it in Git.

On startup, `npm run start:free` restores the configured Zenda Cross MultiStream provider from a pinned revision before starting the API. This makes it available again after Render discards local files. `LUMA_BOOTSTRAP_PROVIDERS` is a comma-separated list of provider IDs, not display names; the default is `autoEmbed` (MultiStream). Up to six configured providers can be restored. `LUMA_BOOTSTRAP_REPOSITORY` selects their repository and revision. An installation failure prevents startup instead of claiming the provider is ready.

Provider bootstrap downloads code only when the configured provider is absent. Existing local enabled/disabled settings are respected while the filesystem exists. After a filesystem reset, configured providers return with defaults. Providers installed only through the app, their custom settings, and provider-side login state do not survive a reset. App library, watchlist, and playback history remain on the phone.

Render Free sleeps after 15 idle minutes, and waking takes about a minute, plus time to restore providers. The Android app may time out during a cold start: wait for the service to be ready, then retry. Free service limits still apply even for a single user. Third-party provider availability and playback are not guaranteed. See https://render.com/docs/free .

## Deployment

Deploy this backend folder as the repository root using `render.yaml`. If deploying the whole Android source project, add `rootDir: backend` to the service definition. No account, repository, or billing details are embedded. No purchase has been made. The separate `render-paid.yaml` in the working source is an optional paid-disk configuration; it is excluded from this free-only ZIP.

After deployment verify `/health`, ensure `/api/status` rejects missing tokens, pair the phone, and check MultiStream on home. Do not claim deployment complete until these checks pass against the real public URL.

## Verification

TypeScript check and 12 backend tests passed. They cover provider restoration after an empty-disk restart, respecting existing settings, bounded single-worker execution, authentication, provider isolation, HTTP policy, catalogs/search/streams, forced refresh, and persisted state. A public Render deployment and free-instance memory performance have not been tested.
