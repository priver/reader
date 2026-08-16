# Product

The RSS reader (working title) is an open-source, installable web application for RSS power users
moving from products such as Feedly or Inoreader. Its primary advantage is exceptionally fast,
keyboard-first feed triage. Privacy, portability, and transparent operation are secondary
principles; manually generated AI synthesis is a post-beta enhancement rather than a dependency of
reading.

## Audience and product promise

The initial audience is individual power users with existing subscriptions. The product provides a
calm chronological inbox, predictable controls, no advertising or behavioral tracking, and
straightforward export. It is a portfolio and learning project that must nevertheless be dependable
enough for personal daily use.

The external beta is English-language, globally accessible, invite-only, and limited to adults.
Primary production data is hosted in the EU. Necessary transfers, remote operator access,
subprocessors, retention, and user-directed email delivery are documented openly.

## Core functionality

**Onboarding.** An administrator issues invitations through a CLI. Users authenticate with an
emailed one-time code and choose either a curated starter-feed catalogue, OPML import, or adding a
feed URL. OPML import previews folders, duplicates, and counts before asynchronous processing;
invalid feeds appear in a failure report with retry actions.

**Subscriptions and organization.** The app discovers and reads public RSS, Atom, and JSON Feed
sources. A subscription may belong to multiple folders. Authenticated/private feeds, newsletters,
social integrations, and proprietary connectors are excluded. Users can export subscriptions as OPML
and export folders, stars, reading state, and generated digests as JSON.

**Reading.** Desktop uses three panes: folders, article list, and reader. Mobile uses folders → list
→ full-screen article navigation. Selecting an article marks it read with an immediate undo option.
Users can star, toggle read state, bulk-mark the current cutoff as read, and open the publisher page
explicitly. Feed-supplied content is sanitized and publisher edits update content without changing
personal state.

The initial keyboard map includes `j`/`k` navigation, `Enter` to read, `o` for the publisher, `s` to
star, `m` to toggle read state, `Shift+A` for bulk read, `/` for search, `g` navigation sequences,
and `?` for help. Single-key shortcuts work only in the reader context, never in inputs, and can be
disabled.

**Search and retention.** PostgreSQL full-text search covers retained articles from current
subscriptions and starred articles from former subscriptions. Results can be filtered by folder,
feed, date, read state, and star state. Unstarred articles are retained for 180 days; starred
articles persist until unstarred or account deletion.

**Images.** Publisher images are never loaded directly in the browser. They are fetched and
transformed asynchronously through a private proxy, served from private object storage, and replaced
by accessible placeholders when unavailable. Relevant publisher-supplied rights information is
preserved; tracking, GPS, and camera metadata are removed.

**Manual digests, post-beta.** A user may generate a thematic digest for the current folder. The
system processes capped, deduplicated new articles and stores the result in the app. Digests contain
three to seven themes, supporting article links, disagreement where present, and notable articles.
Feed text is untrusted data: the model receives no tools, cannot fetch URLs, and must return
validated structured output using only supplied article IDs. Results are cached until eligible
content changes.

## Quality and privacy

The product targets WCAG 2.2 AA and current/previous stable Chrome, Firefox, Safari, and Edge,
including current mobile Safari and Chrome. It supports light/dark themes and compact/comfortable
density. Formal accessibility conformance is claimed only after evaluation.

Only essential authentication/storage mechanisms are used; there are no analytics cookies,
advertising trackers, session replay, or third-party browser telemetry. Product analytics are
pseudonymous and exclude URLs, titles, searches, OPML, article text, and digest content. Accounts
can be exported and deleted; deleted live data is removed promptly and expires from backups within
the disclosed period.

Automated fetching follows the published robots policy, uses conditional requests and an
identifiable contact, and supports item/origin suppression. Privacy, subprocessors, cookies/storage,
accessibility, fetcher behavior, security contact, editorial starter-feed criteria, and
copyright/illegal-content procedures are public beta gates.

## Releases, limits, and success

The 6–8-week milestone is an internal release containing the reader, ingestion, OPML, search,
keyboard UI, hardened fetching, and core tests. External beta follows only after EU production
migration, recovery testing, identity/email, telemetry, image proxy, accessibility, public policies,
and legal-operator questions are resolved. AI follows beta.

Beta limits are 50 accounts, 1,000 subscriptions per account, and 5,000 canonical feeds. Success
after three months means a polished deployed project, 25 activated users, 10 weekly users for four
consecutive weeks, five users with at least 50 subscriptions, and 60% of invitees successfully
importing or adding a feed. The continuation decision also considers reliability, maintenance
staying below four hours per week, and outside contributions.

Explicit non-goals are native apps, collaboration, supported self-hosting, private feeds, podcast
playback, offline article synchronization, full-text extraction, semantic search, personalized
recommendations, billing, and user-selectable AI providers.
