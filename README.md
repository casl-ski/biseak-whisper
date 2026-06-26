# Biseak - Whisper theme

Shopify theme for Biseak's website (`biseak-atelier-de-velo.myshopify.com`, public domain `biseak.com`).

Live theme: **Whisper**, ID `185890537751`.

The bike rental booking widget (`blocks/rental-booking-widget.liquid`,
`assets/rental-booking-widget.js`, `assets/rental-calendar.js`,
`assets/rental-calendar.css`) talks to the separate `biseak-rental-app`
Cloudflare Worker via Shopify's App Proxy — see that repo's README for the
backend/deploy commands.

## Shopify CLI commands

### Local preview

```
shopify theme dev --store biseak-atelier-de-velo.myshopify.com
```

Opens a local preview synced against the live theme's content (not its files) — edits to local
files hot-reload in the preview without touching the live theme until you push.

### Pull (sync local files with what's live, e.g. after editing in the theme editor)

```
shopify theme pull --store biseak-atelier-de-velo.myshopify.com
```

### Push a single file to the live theme (safe, surgical)

```
shopify theme push --theme=185890537751 --only=<path/to/file> --allow-live --nodelete
```

Use one `--only=` flag per file for multiple files. `--nodelete` is important here — it stops
Shopify CLI from deleting any live file that isn't in your local checkout, which matters since
`shopify theme push` without `--only` otherwise treats the push as the full source of truth.

### Push the entire theme (syncs deletions too — only do this deliberately)

```
shopify theme push --theme=185890537751 --allow-live
```

This *will* delete any live file that doesn't exist locally. Only run it when you've confirmed
local is a complete, correct snapshot of what should be live (e.g. right after a `theme pull`).

### Theme Check (lint)

```
shopify theme check --fail-level=error
```

Run before pushing — compare the error/warning count against `main` if unsure whether a failure
is pre-existing or caused by your change:

```
git stash && shopify theme check --fail-level=error; git stash pop
```

### Non-interactive environments

`shopify theme push`/`pull` prompt for a theme if `--theme=<id>` isn't passed and stdin isn't a
TTY (e.g. when run from an agent or CI). Always pass `--theme=185890537751` explicitly in that case.

## Shipping checklist

```
shopify theme check --fail-level=error
shopify theme push --theme=185890537751 --only=<changed files> --allow-live --nodelete
git add <changed files>
git commit -m "..."
git push
```

## Other notes

Tarif de Livraison: Surdimensionné
Tarif de Livraison: Vélo
