# Forever Server

A small collection of independent convenience services for **World of Warcraft: Forever**, currently focused on the Forever Beta and designed to grow into the live-launch utility layer.

Each checker lives as a peer service under `services/`. The repository itself is the neutral host; no checker is architecturally primary.

## Architecture

```text
forever-server/
├── services/
│   ├── beta-blue-checker/
│   │   └── check.mjs
│   └── beta-realm-status/
│       └── check.mjs
├── .github/
│   └── workflows/
│       ├── beta-blue-checker.yml
│       └── beta-realm-status.yml
├── package.json
└── README.md
```

## Services

### beta-blue-checker → Discord `#beta-blue-checker`

Polls Blizzard's official Blue Tracker every five minutes and forwards only Blizzard posts whose topic belongs to **WoW: Forever Beta Discussion** (category `349`).

It:
- posts author, topic title, cleaned excerpt, timestamp, and direct forum link
- suppresses duplicates without a separate database
- bootstraps silently so historical blueposts are not dumped into Discord
- stores the latest processed Blizzard post ID in the Discord webhook's metadata
- can also be run manually from GitHub Actions

Required Actions secret: `DISCORD_WEBHOOK_URL`.

### beta-realm-status → Discord `#beta-realm-status`

Polls Forever Beta service state and resolves several independent signals into one announced state.

Evidence sources:
- **ForeverDB aggregate probes** for the beta login and realm game services. The checker parses ForeverDB's own per-minute timestamps and rejects stale results instead of treating an old page as current truth.
- **Direct TCP probes** from the runtime to Blizzard's beta login endpoint and a realm game-service endpoint. Successful connections are useful positive evidence; failed hosted-runner connections are deliberately treated as inconclusive rather than proof of an outage.
- **Recent official Blizzard tracker posts** in the Forever Beta forum. Explicit "online", "offline", and transition/maintenance language is used as corroborating context.

States:
- 🟢 **online**
- 🔴 **offline**
- 🟡 **degraded**
- ⚪ **unknown** — sources are stale, unavailable, insufficient, or materially contradictory

The resolver is intentionally asymmetric: it is easier to prove that a service answered than to prove that it is globally unavailable. Conflicting evidence therefore degrades to `unknown` rather than manufacturing an outage.

An `unknown` result must occur on two consecutive checks before Discord is notified, which filters one-off source failures without hiding sustained uncertainty. The last confirmed non-unknown state is retained separately.

The sentry also posts one health heartbeat every 24 hours when no transition occurs. This makes "nothing changed" distinguishable from "the monitor itself stopped working."

Persistent state is currently stored in GitHub issue #1. The decision engine is independent of that storage adapter so the state can move to Cloudflare KV or a Durable Object when the scheduler is migrated.

Preferred Actions secret: `DISCORD_REALM_STATUS_WEBHOOK_URL`.
If that secret is absent, the service falls back to `DISCORD_WEBHOOK_URL`.

## Local commands

```bash
npm run check:blue
npm run check:realm
```

The scripts require the same environment variables used by GitHub Actions.

## Scheduling

Both services target a five-minute polling cadence through GitHub Actions. GitHub may occasionally delay scheduled jobs under load, so five minutes is a target interval rather than a hard real-time guarantee.

## Design rule

New Forever utilities should normally be added as sibling directories under `services/`, with their own workflow and narrowly scoped state/secret requirements. This keeps `forever-server` as the common infrastructure layer rather than allowing any one checker to become the implicit root application.
