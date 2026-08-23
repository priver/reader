# 0007: Treat complete feed URLs as public endpoint identity

Status: Accepted

## Context

Reader stores public feeds once and shares their entries across subscriptions. Public feeds commonly
use query parameters and opaque path segments as selectors. The same URL shapes can carry private
capabilities. Generic checks based on parameter names, path shape, or apparent entropy cannot tell
the difference reliably.

Aggressive URL normalization creates another problem. Query order, duplicate parameters, escaped
path spelling, trailing slashes, and even default-looking path segments can change an origin's
response. Content or feed metadata also cannot prove that two endpoints have the same access policy.

## Decision

Reader accepts only absolute public `http` and `https` feed and discovery URLs. It rejects URL user
information, separate credentials, unsupported schemes, malformed hosts and ports, IPv6 zone
identifiers, controls, and URLs longer than 4,096 UTF-8 bytes before or after canonicalization. One
server-owned canonicalizer handles direct input, OPML imports, website-discovery candidates,
redirect targets, and stored endpoint lookup.

Every accepted path and query string is public endpoint identity. Reader preserves it and does not
try to detect secret-looking names or values. The add-feed flow states that Reader may store and
reuse the complete URL and feed data across accounts that submit the same endpoint. Signed,
tokenized, invitation-only, and other confidential URLs are unsupported.

Canonicalization is deliberately conservative. Reader lowercases the scheme and DNS host, converts
internationalized hostnames to their IDNA lookup form, removes a DNS root dot, uses canonical IP
literal spelling, removes a matching default port, removes the fragment, and changes an empty path
to `/`. It preserves the scheme, non-default port, path spelling, trailing and repeated slashes, dot
segments, escaped octets, and raw query, including order, duplicates, blank values, and an explicit
empty query.

Reader follows only `301`, `302`, `303`, `307`, and `308` responses, with at most five hops, after
applying the same URL and public-address policy to every target. Other 3xx responses are terminal
fetch outcomes. A leading chain of `301` and `308` responses updates the canonical fetch endpoint
and leaves the old endpoints as permanent aliases. A `302`, `303`, or `307` target is request-local;
it and all later targets in that chain do not change feed identity.

Normalized canonical endpoints and permanent aliases have one global Feed owner. A permanent
redirect to an owned target converges on the target Feed through an idempotent merge. Reader does
not deduplicate feeds by payload, entries, titles, site URLs, Atom `rel=self`, DNS aliases, or
temporary redirects.

## Consequences

- Reader supports public feeds whose selectors live in paths or queries without changing their
  request semantics.
- Reader cannot make a capability URL private. It provides no token lifecycle, redaction, or private
  feed guarantee.
- Shared feed records remain undiscoverable. Reader returns feed URLs only to subscribed users and
  authorized administrators and excludes them from general logs and telemetry.
- The data model needs a globally unique endpoint and permanent-alias index plus an idempotent feed
  merge path.
- URL, redirect, deduplication, DNS, and SSRF behavior requires deterministic fixtures before shared
  ingestion ships.
