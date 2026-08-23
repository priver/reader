# Product

This document defines the product target through invitation beta.

## Promise

Reader gives experienced RSS users a calm interface for reading public RSS and Atom feeds. Articles
stay in publication order; Reader does not rank them. The app is fast, works on desktop and mobile,
supports keyboard and touch input, and exports subscriptions.

Reader initially competes on the reading experience. Discovery, ranking, collaboration, and content
generation are out of scope.

## First user

The first user already understands RSS, and follows many information-dense sources.

The initial plan assumes one developer working part time for six to ten weeks to reach personal
alpha. This window constrains scope and sequencing. It is not a public launch-date promise. If the
work takes longer, the schedule moves, but the personal-alpha checklist remains the release gate.

Product rollout:

1. Personal alpha on production-like infrastructure
2. Rolling invitations to a small external cohort
3. A free hosted beta with a best-effort support promise

The application is MIT-licensed. The hosted service is intended to remain free indefinitely and
self-funded within bounded usage and retention limits. Invitation beta is a hobby-scale service
without formal compliance certification or a regulated-service commitment.

## Product principles

- Keep publication order chronological. Ranking never replaces it.
- Put reading before discovery, automation, and social behavior.
- Keep the experience calm. Show failures and background work without interrupting reading.
- Let users export subscriptions in a format other feed readers understand.
- Protect privacy by default. Exclude article content and source details from product telemetry.
- Support desktop and mobile as release targets.
- Meet WCAG 2.2 AA as a release criterion.

## Personal alpha checklist

Personal alpha is complete when every item below works at `reader.priver.org` on the target Yandex
Cloud deployment.

### Identity

- Sign in with an emailed one-time code.
- Enroll a passkey from account settings.
- Prefer passkey authentication after enrollment.
- Keep sessions for 30 days on trusted personal devices.
- Require fresh authentication for sensitive identity changes.

### Subscriptions

- Add a public RSS or Atom feed by feed URL or website URL.
- Discover feed links from ordinary website HTML.
- Import OPML folder information into Reader's flat folder model.
- Export subscriptions as OPML.
- Organize each subscription in one folder.
- Enforce a 500-subscription hosted-service limit per user.

Reader accepts no feed username, password, custom header, or other separate authentication material
through beta. It rejects URL user information and non-HTTP schemes. Reader treats every accepted
path and query string as public endpoint identity and may reuse the complete URL and feed data
across accounts that submit the same endpoint. The add-feed flow says this before submission. Users
must not submit signed, tokenized, invitation-only, or otherwise confidential URLs.

Shared feed records are not a public directory. Reader returns feed URLs only to subscribed users
and authorized administrators, but it provides no private-feed or token-redaction guarantee. The
exact endpoint and deduplication rules live in
[`0007-feed-url-policy.md`](decisions/0007-feed-url-policy.md).

### Reading

- Open on all unread articles, newest first.
- Show folders and feeds, an article list, and the reader simultaneously on wide screens.
- Use stacked navigation and bottom destinations on mobile.
- Mark an article read when opened.
- Keep the selected row visible until the user leaves it.
- Navigate next and previous within the current filtered and sorted list.
- Save or unsave an article with one saved state.
- Synchronize coarse reading progress across devices.
- Ask whether to resume an in-progress article.
- Search retained article titles and source names.
- Mark the current scope read with a temporary undo action.
- Support standard reader shortcuts and discoverable shortcut help.
- Support mobile swipe actions for read state and saving with undo.

### Refresh

- Refresh public feeds adaptively from publication history.
- Check high-frequency feeds at least every 30 minutes when they are not under publisher or failure
  backoff.
- Check slow feeds less often.
- Use conditional requests, `Retry-After`, and exponential failure backoff.
- Show accepted, fetching, completed, and cooldown states for manual refresh.
- Show feed failures as quiet per-feed status with actionable details.
- Send no article notifications.

### Content

- Render only article HTML supplied by RSS or Atom through invitation beta.
- Sanitize every stored body before it reaches a browser.
- Render the excerpt and offer an open-original action when a feed contains only an excerpt.
- Open external links in a new tab.
- Proxy article and list images instead of contacting publishers from the browser.

Full-page article downloading and extraction remain post-beta research topics. Do not reserve code
or service boundaries for either feature yet.

## Invitation beta

Invitation beta adds the following after the core reading workflow works in daily use:

- A public email-only form for requesting an invitation
- Administrator review before a request creates an email-bound, single-use invitation with seven-day
  expiry
- A private passkey-protected admin app at `admin.reader.priver.org`
- Google account linking from an authenticated settings flow
- Content-free PostHog Cloud product events
- Click-to-load placeholders for a small trusted media embed allowlist
- GitHub Issues for product feedback and best-effort support
- Public status and operational support information

Administrators may also issue an invitation without a prior request. Requesting an invitation does
not create an account or guarantee access.

Automatic linking by matching email addresses is not allowed. Users attach additional credentials
only from an authenticated session.

## Interaction model

### Desktop

- Use three resizable panes: sources, article list, and reader.
- Persist pane widths per user within bounded layout limits.
- Show unread counts capped at `99+`.
- Use compact editorial list rows with title, source, publication time, a short excerpt, and a
  contextual thumbnail when one exists.
- Keep the article reader visually dominant without hiding context.

### Mobile

- Use bottom destinations for Unread, Feeds, Saved, and Search.
- Preserve the same read, save, progress, and filtering semantics as desktop.
- Pair every gesture with a visible control and an undo path where state changes.

### Visual language

- Use a warm editorial palette with paper-like neutrals and a restrained rust or ochre accent.
- Use Literata for article text and IBM Plex Sans for interface text.
- Self-host variable font subsets, including Cyrillic coverage, on the application's cookieless
  asset origin.
- Use contextual list thumbnails without reserving empty image slots.
- Use short, restrained transitions and honor reduced-motion preferences completely.
- Use warm charcoal surfaces and off-white text in dark mode.
- Limit presentation controls to theme selection through beta; typography, density, and spacing stay
  product-defined.

Detailed visual design sets exact responsive image widths. The architecture does not set them.

## Data behavior

- Existing entries imported with a new feed are available for browsing but start as read.
- Future entries begin unread.
- Ordinary entries, including their sanitized body and metadata, remain available for 90 days.
- Saving an entry before ordinary retention expires preserves its body and metadata until no user
  keeps it saved.
- Unsubscribing removes ordinary history and state but preserves saved items.
- Publisher changes update an existing article, including content currently saved.
- Account deletion immediately removes identity and private user state.
- Shared records for public feeds may remain after one account is deleted.

Storage retention and state invariants live in [`data-model.md`](data-model.md).

## Non-goals through beta

- Algorithmic ranking
- Ads or monetization
- Social feeds, sharing networks, or team collaboration
- Native mobile applications
- Offline reading
- AI summaries or recommendations
- Full-text search
- Highlights, notes, or saved-item collections
- Newsletters, podcasts, JSON Feed, or social sources
- Authenticated or private feeds
- Full linked-page article extraction

## Success gates

Invitation beta starts only after all of these conditions hold:

- The personal alpha feature checklist is complete.
- Feed refresh, API latency, load, security, backup, and restore gates pass.
- The monthly operating forecast remains below the review ceiling.
- The product can add users gradually without manual data repair.

The primary product metric is the share of invited users who import feeds and continue returning
through week four.

Operational load and latency targets live in [`architecture.md`](architecture.md). Test gates live
in [`testing.md`](testing.md), and the spend review threshold lives in
[`deployment.md`](deployment.md).

## Scope pressure

If the initial schedule slips, defer these beta additions first: Google OAuth, PostHog, polished
admin UI, and trusted embeds. Preserve the daily reading workflow, security boundaries, data
durability, and recovery work.

## Post-beta

After product validation, evaluate an offline-capable PWA first. Research full linked-page article
extraction separately. Base its design on evidence gathered then, not on an implementation plan
written during beta.
