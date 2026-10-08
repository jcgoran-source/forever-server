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

Polls Forever Beta service state every five minutes and notifies Discord only when the observed state changes.

It checks:
- Blizzard's beta login endpoint at `test.actual.battle.net:1119`
- a beta realm game-service endpoint on port `3724`
- ForeverDB's aggregate realm check as corroboration/fallback

States:
- 🟢 online
- 🔴 offline
- 🟡 degraded

Persistent state is stored in GitHub issue #1 so scheduled runners remain otherwise stateless.

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
