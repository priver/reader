# 0008: Version entry identity and stored content

Status: Accepted

## Context

Publishers do not use RSS and Atom identifiers consistently. Entries may omit IDs, repeat them,
change links, contain invalid dates, or publish several revisions in one response. Reader still
needs one feed-scoped result for retries and Feed merges without guessing across unrelated
publications.

Stored bodies need the same stability. The worker and API deploy independently, bodies live outside
PostgreSQL, and sanitizer changes may rewrite saved content long after its source XML has been
discarded. An implicit Go struct or compression format would make integrity checks, migrations, and
fixture results depend on whichever binary happened to write an object.

## Decision

### Entry identity

Reader assigns one v1 identity key within the owning Feed. It uses the first available source in
this order:

1. RSS `<guid>` or Atom `<id>`
2. Canonical publisher link
3. Normalized title plus valid publication time
4. A source fingerprint over normalized title, normalized author names, valid publication time, and
   the selected feed-provided body

Publisher IDs are opaque and case-sensitive after XML entity decoding and removal of surrounding XML
whitespace: tab, LF, CR, and space. Reader does not interpret an ID as a URL, including an RSS GUID
whose `isPermaLink` attribute is true. An empty ID or one longer than 4,096 UTF-8 bytes falls
through to the next source.

Entry-link normalization resolves relative links against the effective entry base, then the feed's
public-site URL, then its canonical endpoint. It accepts only absolute `http` and `https` URLs
without user information. It applies [ADR 0007](0007-feed-url-policy.md)'s conservative scheme,
host, port, path, and query rules but preserves fragments because separate entries may use anchors
on one page.

Fallback titles and author names use Unicode NFC, trim surrounding whitespace, and collapse each
Unicode whitespace run to one ASCII space. Valid publication times use UTC `time.RFC3339Nano`, which
omits trailing fractional zeros. The source body is `gofeed.Item.Content` when non-empty and
otherwise `gofeed.Item.Description`. The source fingerprint uses that parser output, not sanitized
HTML, so a sanitizer migration cannot change entry identity. Reader rejects an item with no usable
input at any tier.

The key is `v1:<tier>:sha256:<lowercase-hex>`, where the tier is `publisher-id`, `publisher-link`,
`published-title`, or `source-fingerprint`. SHA-256 input starts with the ASCII domain tag
`reader-entry-identity-v1`. The tier and every subsequent UTF-8 value are encoded as a four-byte
big-endian length followed by that many bytes. The published-title values are title and timestamp.
The source-fingerprint values are title, author names joined by LF, timestamp or empty string, and
source body. PostgreSQL enforces uniqueness on Feed and the complete key.

The strict preference is intentional. Duplicate publisher IDs represent one entry even when links
differ. Different publisher IDs remain different entries even when links match. Duplicate links
collapse only when both items lack publisher IDs. A changed publisher ID creates a new entry rather
than allowing a weaker link match to override the publisher's chosen identity. An item that reaches
the source-fingerprint tier may also become a new entry when its body changes; no stable update key
exists in that case.

When one response repeats a key, Reader selects one candidate independent of document order. It
prefers the greatest valid update time, then the greatest valid publication time, then the
lexicographically smallest SHA-256 digest of the normalized durable representation. A Feed merge
retains the target Feed's Entry when keys collide, retargets user state and saved references, and
applies the same representation selection. Non-colliding keys remain separate.

If one user has state on both colliding Entries, saved combines with OR, explicit unread wins over
read, progress keeps the furthest value, and last-opened time keeps the latest value. When the
selected source representation changes the surviving target Entry, its content version increments
under the normal publisher-revision rule.

### Publisher revisions

Each Entry starts at content version 1. The representation digest is lowercase SHA-256 over this RFC
8785 canonical I-JSON value, shown with whitespace only for readability:

```json
{
  "authors": ["Author One"],
  "body": {
    "html": "<p>Hello</p>",
    "source": "content",
    "text": "Hello"
  },
  "images": [],
  "lead_image_id": null,
  "published_at": "2026-08-23T12:00:00Z",
  "publisher_url": "https://example.com/articles/1",
  "title": "Hello",
  "updated_at": null
}
```

The exact fields are publisher URL, normalized title and ordered author names, valid publication and
update times, selected body kind, sanitized HTML, derived plain text, image manifest, and lead-image
projection. Absent URLs and times are null. Fetch time, response formatting, unknown extension
fields, version numbers, integrity metadata, compression bytes, and object keys do not participate.

An observation with the same identity and representation digest is a retry or no-op. It keeps the
current content version and object. Any durable representation change increments the positive 64-bit
version by exactly one, including metadata-only edits and updates to saved entries. A failed
publication does not make an unverified version current. A later return to old content still
receives a new version; Reader never decrements or reuses one.

PostgreSQL stores the version in a signed 64-bit integer, but writers stop at the I-JSON
exact-integer limit of 9,007,199,254,740,991. Reaching that limit fails the update and requires
operator action.

Pure schema, compression, or integrity migrations preserve content version when the browser
representation and lead image remain identical. A migration that changes sanitized HTML, plain text,
image data, or publisher metadata increments it. API-only rendering changes use the separate
rendering-schema component of the DTO ETag.

### Content envelope

Envelope v1 is RFC 8785 canonical I-JSON compressed with gzip level 6. The gzip header has zero
modification time, OS 255, and no name, comment, or extra fields. Objects use media type
`application/vnd.reader.content+json` and content encoding `gzip`. The uncompressed object has these
required fields; empty values are not omitted. Whitespace below is only for readability:

```json
{
  "body": {
    "html": "<p>Hello</p>",
    "source": "content",
    "text": "Hello"
  },
  "content_version": 1,
  "images": [],
  "integrity": {
    "algorithm": "sha256",
    "digest": "962b884b01648acde07ad4506aa3593ea2752e5c107ce132a4439dc208aea7ca"
  },
  "lead_image_id": null,
  "normalizer_version": 1,
  "sanitizer_version": 1,
  "schema_version": 1
}
```

`body.source` is `content`, `summary`, or `empty`. The HTML is the final sanitized fragment. Plain
text comes from that fragment: `<br>` produces one newline, block boundaries produce two, other
Unicode whitespace runs collapse to one ASCII space, and surrounding whitespace is removed. An image
placeholder contributes its normalized alt text at that position.

Every accepted body image becomes `<reader-image data-image-id="image-N"></reader-image>`, numbered
from zero in document order. Before creating these elements, the normalizer removes
publisher-supplied `reader-image` elements and reserved `data-image-id` attributes. Each occurrence
has one manifest item with exactly `id`, `source_url`, and `alt` fields. Repeated source URLs remain
separate because position and alt text may differ. Envelope v1 does not store image dimensions;
publisher declarations are not trustworthy and intrinsic dimensions would require an additional
fetch during ingestion.

Alt text uses the same Unicode and whitespace normalization as titles. If the normalized item-level
image URL matches a body manifest source, the first matching body item becomes the lead. Otherwise
the worker appends a lead-only item after all body items, using the item image title as alt text.

The normalizer resolves image URLs against the effective entry base and accepts only normalized
public `http` and `https` URLs without user information. Rejected images contribute escaped alt text
when non-empty and otherwise disappear. The first accepted item-level image is the lead image and is
represented by the matching or appended item above. Otherwise the first body image leads.
`lead_image_id` is null when neither exists. Durable content never contains signed imgproxy URLs.

The integrity digest is lowercase SHA-256 over the RFC 8785 canonical UTF-8 envelope with the entire
`integrity` member omitted. A decoder bounds decompression, rejects duplicate JSON properties,
checks the schema and structure, verifies the digest, and then validates placeholders and public
image URLs. Every body manifest ID must occur once in HTML. The only permitted unreferenced item is
an item-level lead image. Unknown placeholders, duplicate IDs, an invalid lead reference,
unsupported versions, or any integrity failure make the envelope unreadable.

### Compatibility

Identity and envelope versions are durable behavior. Existing identity keys are immutable. A later
identity algorithm introduces a new version, dual-computes supported keys during rollout, and
backfills explicit aliases before writers switch. It never silently recomputes keys or merges saved
and read state.

Envelope readers dispatch strictly by schema version; writers emit only the current version. Deploy
readers for both old and new versions before enabling new writes. A backfill verifies the old
object, writes and verifies a new object, then changes the current reference through the
content-publication protocol. It does not mutate an object in place. Old decoders and objects remain
through application, queue, rollback, and recovery overlap. Corrupt or unsupported content fails
closed and never reaches the browser.

## Consequences

- Well-formed publisher IDs win even when weaker fields suggest a match. This avoids speculative
  merges at the cost of duplicates when a publisher changes IDs.
- Deterministic fallbacks and duplicate selection make retries, fixtures, and Feed merges
  reproducible.
- Canonical JSON and deterministic gzip make repeated object writes byte-identical; the internal
  digest verifies the decoded envelope independently of Object Storage transport checksums.
- The API must support version overlap, and sanitizer migrations may need a bounded object backfill.
- Issue #26 defines publication and orphan recovery. Issues #7 and #31 implement this contract and
  its redistributable fixtures.
