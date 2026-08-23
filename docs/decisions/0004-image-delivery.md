# 0004: Signed imgproxy with two-layer caching

Status: Accepted

## Context

Loading publisher images directly reveals a reader's IP and article access. An image proxy that
accepts arbitrary URLs becomes an SSRF and resource-exhaustion service. Cloudflare Free does not
cache variants by `Accept`, so one content-negotiated URL can serve an incorrect cached format.

## Decision

Store app-owned image placeholders and a normalized image manifest with sanitized content. When the
API serves an article or list, expand body placeholders or the lead-image projection to HMAC-signed
`https://reader.mprvr.net/images/` URLs using the current key. Keep imgproxy private behind Nginx,
restrict it to fixed presets, and reject private network sources. Emit explicit AVIF and WebP
`<picture>` candidates for a small, fixed set of responsive widths chosen during visual design.

Nginx publishes the signed image path on the same cookieless origin as the end-user build assets
from [ADR 0006](0006-static-spa-delivery.md), under a separate `/images/` route. Cache immutable
content-versioned paths in Cloudflare and a bounded Nginx file cache. Use cache locking, brief
negative caching, and stale successful responses during upstream failure. The security policy
defines the current cache limit.

## Consequences

- Browsers do not contact publishers for article images.
- Image requests carry no Reader cookies or authorization headers.
- Public source URLs may be visible. Signatures prevent source and preset tampering.
- The API generates signed URLs at response time, so saved bodies survive signing-key rotation.
- Each blue-green VM begins with a cold local cache while Cloudflare may remain warm.
- Changing an image source or content version creates a new immutable path, which removes the need
  for a global purge.
