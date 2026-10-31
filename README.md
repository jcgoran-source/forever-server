# Forever Server

Live utility infrastructure for **World of Warcraft: Forever**.

The repository currently contains two Cloudflare runtimes and a third synthesis subsystem:

- `realm-status` — live service monitoring and Discord status alerts.
- `forever-updates` — Blizzard-authored Forever news, blueposts, hotfixes, operational notices, official forum replies, and Wowhead Forever articles.
- `forever-briefing` — deterministic change synthesis fed directly by `forever-updates`; it does not poll either publisher independently.

## Architecture

```text
forever-server/
├── services/
│   ├── forever-briefing/
│   │   ├── backfill.mjs
│   │   ├── backfill.test.mjs
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
- compact Discord excerpts capped at 850 characters, with paragraph breaks preserved where the source provides them
- official WoW news articles use the Blizzard article as the primary link when available

The same once-per-minute Worker now also polls the Wowhead Forever RSS feed (`https://www.wowhead.com/news/rss/forever`). It maintains a **separate** persistent article-ID cursor, silently seeds currently visible items on first successful collection, and sends each subsequent new article to `#forever-updates` with a distinct Wowhead attribution and a link to the original article. These articles also enter the shared briefing ledger and its daily 6:00 PM Pacific digest. Wowhead fetch/parse errors do not block the Blizzard tracker or the briefing schedule. The RSS is news content, not official Blizzard communication; Wowhead datamining and editorial reporting are labeled accordingly.

Cloudflare secret: `DISCORD_FOREVER_UPDATES_WEBHOOK_URL`.

All Discord outputs also support an optional shared `FOREVER_TOOLS_ROLE_ID`. When configured with a valid Discord role ID, the tool prepends that role mention and permits only that role to ping; when absent or invalid, mentions remain suppressed.

## forever-briefing → Discord `#forever-briefing`

The change synthesizer consumes each qualifying Blizzard post and new Wowhead Forever news article from `forever-updates` after relevance filtering. It does not make a second request to the Blizzard tracker.

Each update is normalized into a persistent change record containing:

- source post ID, title, timestamp, and source URL
- deterministic domain classification: Classes, Professions, Dungeons & Raids, PvP, Quests & World, Items & Economy, UI & Systems, Launch & Servers, Known Issues & Fixes, or General
- a concise source-grounded summary
- general priority

The briefing layer is deliberately **character- and plan-agnostic**. It does not assign special relevance to a particular class, faction, profession, route, realm type, or character.

Briefings deliberately do not duplicate each raw news item. New changes accumulate in a separate SQLite-backed `BriefingState` Durable Object. Pending changes are released **once daily at approximately 6:00 PM Pacific** in `America/Los_Angeles`. The schedule follows daylight-saving time automatically. News arriving before 6:00 PM is included that evening; news arriving at or after 6:00 PM waits until the following day. No empty briefing is sent when nothing changed.

The first implementation is deterministic rather than model-generated. It preserves the underlying Blizzard wording and source links instead of inventing a stronger interpretation than the source supports. A later semantic/LLM layer can operate on this generalized ledger without replacing the source-of-truth machinery.

Cloudflare secret for Discord delivery: `DISCORD_FOREVER_BRIEFING_WEBHOOK_URL`. The shared `FOREVER_TOOLS_ROLE_ID` setting is inherited by this briefing output as well.

If that secret is absent, synthesis and persistence continue normally; only Discord briefing delivery is paused, and pending changes are retained.

### Controlled historical backfill

`forever-briefing/backfill.mjs` provides an intentionally one-shot historical import path for testing or seeding the ledger. A backfill is armed temporarily with a unique key, a start timestamp, and a hard item cap. It:

- reads the live Blizzard Blue Tracker and hydrates candidate posts
- applies the same Forever-relevance rules as the live collector
- suppresses mirrored duplicate announcements
- writes imported records to the persistent briefing ledger as historical/non-pending changes
- emits one explicitly labeled historical digest
- persists the unique backfill key only after successful Discord delivery

The completed key makes retries idempotent. Backfill configuration is removed from the deployed Worker after the run; the reusable code and regression tests remain.

The first controlled test used `prelaunch-2026-10-20-v1`, beginning October 20, 2026 with a maximum of 12 unique Blizzard items. It completed successfully.

## realm-status → Discord `#forever-realm-status`

The realm sentry separates environment configuration, evidence resolution, and runtime/state adapters.

Current authoritative profile: `FOREVER_ENV=live`.

Before Early Name Reservation the live profile reports **PRE-LAUNCH** while monitoring the Americas live login infrastructure. At the official reservation opening it transitions to **NAME RESERVATION OPEN** without conflating that phase with gameplay availability. After the November 4 launch it begins requiring realm-game evidence as that becomes available.

### Evidence model

The sentry considers:

- fresh ForeverDB status
- direct TCP reachability from Cloudflare
- recent official Blizzard status or maintenance language from live Forever General Discussion and late Beta operational posts

States are **PRE-LAUNCH**, **NAME RESERVATION OPEN**, **ONLINE**, **OFFLINE**, **DEGRADED**, and **UNKNOWN**.

Failed hosted-runtime TCP probes are inconclusive rather than proof of an outage. Conflicting or stale evidence becomes `UNKNOWN`. Two consecutive unknown observations are required before Discord notification. A 24-hour internal health marker is refreshed silently for observability; healthy heartbeat messages are not posted to Discord.

### Scheduling

The authoritative Cloudflare Worker checks every **30 seconds** through a self-rescheduling Durable Object alarm.

A one-minute Cron Trigger remains as a watchdog. It verifies that the alarm loop has a near-future alarm and repairs the loop if necessary.

Persistent state lives in a SQLite-backed Durable Object and Worker observability is enabled. Realm-status Discord messages also honor the optional shared `FOREVER_TOOLS_ROLE_ID` role mention.

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

Non-secret runtime setting:

- `FOREVER_TOOLS_ROLE_ID` — optional Discord role ID used to give all three tools a shared notification-role ping

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
