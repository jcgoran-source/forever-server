# Forever Server

A collection of independent convenience services for **World of Warcraft: Forever**, now running the live/prelaunch Forever profile, with the retired Beta profile retained for history and fallback.

## Architecture

```text
forever-server/
├── services/
│   ├── beta-blue-checker/
│   │   └── check.mjs
│   └── realm-status/
│       ├── core.mjs
│       ├── core.test.mjs
│       ├── discord.mjs
│       ├── profiles.mjs
│       ├── sensors.mjs
│       ├── sentry.mjs
│       ├── worker.mjs
│       ├── wrangler.jsonc
│       └── runtimes/
│           └── github.mjs
└── .github/workflows/
    ├── beta-blue-checker.yml
    ├── realm-status-github-fallback.yml
    └── deploy-realm-status-cloudflare.yml
```

## beta-blue-checker → Discord `#beta-blue-checker`

Polls Blizzard's official Blue Tracker and forwards Blizzard posts belonging to the Forever Beta forum.

Required Actions secret: `DISCORD_WEBHOOK_URL`.

## realm-status → Discord `#beta-realm-status`

The realm sentry is now split into three independent layers:

1. **Environment profile** — endpoints, ForeverDB labels, Blizzard forum/category and evidence-age thresholds.
2. **Sentry engine** — evidence collection, confidence/conflict resolution, UNKNOWN handling, transition suppression and heartbeat policy.
3. **Runtime adapter** — scheduling, TCP implementation and state persistence.

Current authoritative profile: `FOREVER_ENV=live`.

The live profile is already active. Before launch it reports PRE-LAUNCH and monitors the Americas login infrastructure; after the November 4 launch time it begins requiring realm-game evidence as that becomes available.

### Evidence model

The sentry considers:
- fresh ForeverDB aggregate login/realm probes
- direct TCP reachability probes
- recent official Blizzard status/maintenance language

States are **online**, **offline**, **degraded**, and **unknown**. Failed hosted-runtime TCP probes are inconclusive rather than proof of an outage. Conflicting or stale evidence becomes `unknown`. Two consecutive unknown observations are required before Discord notification. A 24-hour health heartbeat distinguishes a stable monitor from a dead one.

### Cloudflare Worker (target runtime)

`services/realm-status/worker.mjs` is configured for:
- one-minute Cron Trigger: `* * * * *`
- Cloudflare outbound TCP sockets
- SQLite-backed Durable Object state
- environment selection through `FOREVER_ENV`
- persisted Worker logs/observability

The Worker is cron-only and exposes no public route. It silently bootstraps its own state on first execution, so it can be validated alongside the GitHub fallback without announcing a fake initial transition.

### GitHub Actions (manual fallback)

Cloudflare is now the authoritative scheduled runtime. The GitHub-backed sentry remains available only as a manual fallback; its issue-backed state is a separate runtime adapter sharing the same evidence and decision logic.

### Cloudflare deployment

The manual workflow **Deploy Realm Sentry to Cloudflare** runs resolver tests, deploys the Worker, then syncs the existing Discord webhook into Cloudflare as a Worker secret.

Required GitHub Actions secrets:
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `DISCORD_REALM_STATUS_WEBHOOK_URL` (already configured)

## Local commands

```bash
npm run check:blue
npm run check:realm
npm run test:realm
```

## Design rule

Environment-specific facts belong in profiles; runtime-specific behavior belongs in adapters; evidence resolution belongs in the shared sentry engine.
