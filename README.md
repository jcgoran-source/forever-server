# Forever Server

Live utility infrastructure for **World of Warcraft: Forever**.

The repository currently contains two Cloudflare runtimes and a third synthesis subsystem:

- `realm-status` — live service monitoring and Discord status alerts.
- `forever-updates` — Blizzard-authored Forever news, blueposts, hotfixes, operational notices, and official forum replies.
- `forever-briefing` — deterministic change synthesis fed directly by `forever-updates`; it does not poll Blizzard independently.

## Architecture

```text
forever-server/
├── services/
│   ├── forever-briefing/
│   │   ├── discord.mjs
│   │   ├── synthesizer.mjs
│   │   └── synthesizer.test.mjs
│   ├── forever-updates/
│   │   ├── collector.mjs
│   │   ├── core.mjs
│   │   ├── core.test.mjs
│   │   ├── discord.mjs
│   │   ├── worker.mjs
│   │   └── wrangler.jsonc
│   └── realm-status/
│       ├── core.mjs
│       ├── core.test.mjs
│       ├── discord.mjs
│       ├── profiles.mjs
│       ├── sensors.mjs
│       ├── sensors.test.mjs
│       ├── sentry.mjs
│       ├── worker.mjs
│       ├── wrangler.jsonc
│       └── runtimes/
│           └── github.mjs
└── .github/workflows/
    ├── deploy-forever-updates-cloudflare.yml
    ├── deploy-realm-status-cloudflare.yml
    ├── forever-updates-cloudflare-build.yml
    ├── realm-status-cloudflare-build.yml
    └── realm-status-github-fallback.yml
```

## forever-updates → Discord `#forever-updates`

Cloudflare polls Blizzard's global WoW Blue Tracker once per minute. The source contains Blizzard-authored posts only, so ordinary player discussion never enters the collector.

A post is Forever-relevant when it is:

- in **World of Warcraft: Forever General Discussion** (category `347`);
- in **WoW: Forever Community Connections** (category `348`);
- a late post in retired **WoW: Forever Beta Discussion** (category `349`); or
- elsewhere in the Blizzard tracker and its title or post body explicitly concerns **World of Warcraft: Forever / WoW Forever**.

This intentionally covers official Blizzard News mirrors, operational posts, patch or hotfix posts with a Forever section, and Blizzard replies inside Forever community discussions.

The collector attempts to hydrate unseen tracker entries from the forum's full-post endpoint before relevance classification. If hydration fails, it falls back to the tracker excerpt instead of failing the poll.

Other behavior:

- one-minute Cloudflare Cron
- SQLite-backed Durable Object state
- silent first-run bootstrap
- exact Blizzard post-ID cursor
- duplicate suppression for mirrored announcements
- tracker-window gap detection with a Discord warning
- official WoW news articles use the Blizzard article as the primary link when available

Cloudflare secret: `DISCORD_FOREVER_UPDATES_WEBHOOK_URL`.

## forever-briefing → Discord `#forever-briefing`

The change synthesizer consumes each qualifying Blizzard post from `forever-updates` after relevance filtering. It does not make a second request to the Blizzard tracker.

Each update is normalized into a persistent change record containing:

- source post ID, title, timestamp, and source URL
- deterministic domain classification: Classes, Professions, Dungeons & Raids, PvP, Quests & World, Items & Economy, UI & Systems, Launch & Servers, Known Issues & Fixes, or General
- a concise source-grounded summary
- priority
- launch-plan relevance and explicit focus tags

Current launch-plan focus rules recognize Mage/Frost, launch/server conditions, the early Horde route, planned professions, early dungeons, and PvP/layering.

Briefings deliberately do not duplicate each raw bluepost. New changes accumulate in a separate SQLite-backed `BriefingState` Durable Object. After **10 minutes with no new qualifying Blizzard post**, the pending changes are grouped into one briefing. If Blizzard posts continuously, a briefing is forced after six hours.

The first implementation is deterministic rather than model-generated. It preserves the underlying Blizzard wording and source links instead of inventing a stronger interpretation than the source supports. A later semantic/LLM layer can operate on this ledger without replacing the source-of-truth machinery.

Cloudflare secret for Discord delivery: `DISCORD_FOREVER_BRIEFING_WEBHOOK_URL`.

If that secret is absent, synthesis and persistence continue normally; only Discord briefing delivery is paused, and pending changes are retained.

## realm-status → Discord `#forever-realm-status`

The realm sentry separates environment configuration, evidence resolution, and runtime/state adapters.

Current authoritative profile: `FOREVER_ENV=live`.

Before launch the live profile reports **PRE-LAUNCH** and monitors the Americas live login infrastructure. After launch it begins requiring realm-game evidence as that becomes available.

### Evidence model

The sentry considers:

- fresh ForeverDB status
- direct TCP reachability from Cloudflare
- recent official Blizzard status or maintenance language from live Forever General Discussion and late Beta operational posts

States are **PRE-LAUNCH**, **ONLINE**, **OFFLINE**, **DEGRADED**, and **UNKNOWN**.

Failed hosted-runtime TCP probes are inconclusive rather than proof of an outage. Conflicting or stale evidence becomes `UNKNOWN`. Two consecutive unknown observations are required before Discord notification. A 24-hour health heartbeat distinguishes a stable monitor from a dead one.

### Scheduling

The authoritative Cloudflare Worker checks every **30 seconds** through a self-rescheduling Durable Object alarm.

A one-minute Cron Trigger remains as a watchdog. It verifies that the alarm loop has a near-future alarm and repairs the loop if necessary.

Persistent state lives in a SQLite-backed Durable Object and Worker observability is enabled.

### GitHub fallback

`realm-status-github-fallback.yml` is manual-only. It shares the evidence engine but uses GitHub issue #1 for state and is retained as an emergency fallback rather than a second scheduler.

## Cloudflare deployment

Both services have manual deployment workflows. Each deployment runs its tests before uploading the Worker and syncing its Discord webhook secret.

Repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `DISCORD_REALM_STATUS_WEBHOOK_URL`
- `DISCORD_WEBHOOK_URL` for the current Forever updates webhook
- `DISCORD_FOREVER_BRIEFING_WEBHOOK_URL` for synthesized change briefings

## Local commands

```bash
npm run test
npm run test:realm
npm run test:updates
npm run test:briefing
npm run check:realm
```

## Design rule

Environment-specific facts belong in profiles; runtime-specific behavior belongs in adapters; evidence and relevance logic belong in shared testable modules. New Forever services should remain siblings under `services/`.
