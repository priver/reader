# Data model

This document defines the conceptual target model and invariants through invitation beta. It is not
a SQL schema. The first migrations and fixture corpus will determine exact columns, primary-key
representations, and indexes while preserving the versioned entry and content contracts below.

## Storage boundaries

| Store                           | Owns                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Application PostgreSQL database | Users, invitation requests, invitations, folders, feeds, subscriptions, entries, sparse user state, jobs, fetch history, audit records |
| Kratos PostgreSQL database      | Identities, credentials, sessions, verification, recovery, social login                                                                |
| Private content Object Storage  | Versioned compressed envelopes for sanitized feed bodies                                                                               |
| Private browser-release buckets | Versioned HTML, release manifests, and content-addressed browser assets                                                                |
| Nginx disk cache                | Rebuildable processed image responses; never authoritative data                                                                        |

Application and River tables share one database and transaction boundary. Kratos uses a distinct
database and role in the same initial managed cluster. Application code does not query Kratos tables
directly.

Browser releases are deployment artifacts, not application records or user data. Their 45-day
stale-document retention and reference-aware cleanup policy live in
[`deployment.md`](deployment.md#backups-and-recovery) and
[`0006-static-spa-delivery.md`](decisions/0006-static-spa-delivery.md).

## Ownership model

Public feed data is global. User choices and state are private.

```mermaid
erDiagram
  KRATOS_IDENTITY ||--|| USER : maps_to
  USER ||--o{ INVITATION : creates
  INVITATION_REQUEST o|--o| INVITATION : approved_as
  USER ||--o{ FOLDER : owns
  USER ||--o{ SUBSCRIPTION : owns
  FOLDER ||--o{ SUBSCRIPTION : contains
  FEED ||--o{ SUBSCRIPTION : followed_by
  FEED ||--o{ ENTRY : publishes
  ENTRY ||--o| CONTENT_OBJECT : has_current
  USER ||--o{ ENTRY_STATE : records
  ENTRY ||--o{ ENTRY_STATE : receives
  USER ||--o{ ADMIN_AUDIT : performs
  FEED ||--o{ FETCH_ATTEMPT : records
```

The diagram is conceptual. `KRATOS_IDENTITY` is an external identity reference, not an application
table join.

## Entities

### User

Each application profile maps to one immutable Kratos identity ID.

Owns:

- Preferences and theme
- Folders and subscriptions
- Sparse article state
- Subscription export and deletion lifecycle
- Optional application roles

Email addresses and credentials remain Kratos-owned. Copy identity traits into application data only
when a product requirement needs them.

### Invitation request

An unauthenticated visitor submits one email address through the public form. The request grants no
access and contains no registration token or reusable credential.

Invariants:

- At most one pending request exists for an email address.
- A pending request expires 30 days after submission.
- Only an administrator may approve or reject a request.
- Approval creates a separate invitation; rejection and expiry cannot be redeemed.
- The public response does not reveal whether the email belongs to an account, request, or existing
  invitation.

The record contains the email address, request and expiry times, resolution status, and the optional
resulting invitation reference. Email comparison must use the same rules as identity registration.

### Invitation

An administrator creates a single-use registration invitation directly or by approving an invitation
request for one email address.

Invariants:

- Expires seven days after issuance.
- Stores no reusable login credential.
- Cannot be redeemed for a different email address.
- Records creator, optional source request, redemption, expiry, and revocation for audit.

### Folder

A user-owned named group. Each subscription belongs to at most one folder. OPML import maps outline
information into this flat model. The import design will define how to handle nested paths,
duplicate placements, and naming collisions.

### Feed

A globally shared public RSS or Atom source.

Owns:

- Canonical fetch URL, permanent endpoint aliases, and public site URL
- Display metadata
- HTTP validators
- Publication history
- Adaptive refresh schedule
- Health and failure state

The model stores no separate feed credentials or custom request headers through beta. The complete
canonical URL, including its path and query, is public endpoint identity. Signed, tokenized, and
otherwise confidential URLs are unsupported.

Endpoint invariants:

- Each normalized canonical URL or permanent alias has one global Feed owner.
- A leading chain of HTTP `301` and `308` responses may replace the canonical fetch URL. Preserve
  prior permanent endpoints as aliases so later submissions resolve to the same Feed.
- Temporary redirect targets never become aliases.
- If a permanent redirect reaches another Feed's endpoint, the target Feed survives an idempotent
  merge. Preserve source-only subscriptions and folder placement. When one user has both
  subscriptions, retain the target subscription.
- Do not merge Feeds by response content, parsed entries, title, public site URL, Atom `rel=self`,
  DNS alias, or temporary redirect target.

Entry collision behavior during a Feed merge follows the feed-scoped identity contract below. The
URL contract lives in [`0007-feed-url-policy.md`](decisions/0007-feed-url-policy.md).

### Subscription

A private user-to-feed relationship.

Owns:

- Folder placement
- Subscription creation time
- Initial read boundary
- Bulk read watermark

The hosted service accepts at most 500 active subscriptions per user.

### Entry

A feed-scoped, globally shared publication record.

Owns:

- Feed relationship
- Stable feed-scoped identity
- Publisher URL
- Title, author, publication time, and update time
- Validated lead-image source for list-thumbnail projection
- Current content-object reference
- Content version

Publisher updates replace the current ordinary and saved representation. Reader does not expose
article revision history through beta.

#### Identity

Each Entry has an immutable versioned identity key unique within its Feed. Identity v1 uses the
first available source:

1. Opaque, case-sensitive RSS GUID or Atom ID after removal of surrounding XML whitespace
2. Canonical publisher link
3. Normalized title plus valid publication time
4. A source fingerprint over normalized title, authors, valid publication time, and selected
   feed-provided body

The stored form is `v1:<tier>:sha256:<lowercase-hex>`.
[ADR 0008](decisions/0008-entry-content-contracts.md) defines exact normalization, hash framing, and
fallback inputs. Reader rejects an item with no usable identity input. It never uses fetch time,
item position, or a random value.

A repeated key in one response is one candidate Entry. Reader chooses the greatest valid update
time, then greatest valid publication time, then the lexicographically smallest normalized
representation digest. Document order cannot change the winner. Different publisher IDs remain
different entries even when their links match; changing a publisher ID creates a new Entry.

When a permanent redirect merges Feeds, non-colliding Entries move to the target Feed. For an
identity collision, the target Entry ID survives and the same duplicate rule selects its current
representation. Retarget private Entry state and saved references. If one user has both state rows,
saved is true when either was saved, explicit unread wins over read, reading progress keeps the
furthest value, and last-opened time keeps the latest value.

#### Content version

Content version is a positive monotonic 64-bit integer. A new Entry starts at 1. For the same
identity, a changed durable representation increments it by exactly one; an unchanged normalized
representation keeps the current version and object. The digest covers publisher URL, normalized
title and authors, valid dates, body source kind, sanitized HTML, plain text, image manifest, and
lead-image projection. It excludes fetch and XML formatting, unknown fields, storage metadata, and
compression bytes.

Writers stop at the I-JSON exact-integer limit of 9,007,199,254,740,991 even though PostgreSQL uses
a signed 64-bit column.

Failed object publication does not make a proposed version current. Versions never decrement or
repeat, including when a publisher restores earlier content. A pure storage-schema or compression
migration may preserve the version when browser output and lead image remain identical. Any
migration that changes durable publisher output increments it.

### Content object

Metadata for an object in private Object Storage.

Envelope v1 is RFC 8785 canonical I-JSON compressed with deterministic gzip level 6. The gzip header
has zero modification time, OS 255, and no name, comment, or extra fields. Objects use media type
`application/vnd.reader.content+json` and content encoding `gzip`.

Every field is required, including empty arrays and null values:

| Field                | Contract                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| `schema_version`     | Positive integer selecting the strict decoder; v1 is `1`                    |
| `content_version`    | Matches the current Entry content version                                   |
| `normalizer_version` | Version of deterministic HTML and metadata normalization                    |
| `sanitizer_version`  | Version of the final Bluemonday policy                                      |
| `body.source`        | `content`, `summary`, or `empty`                                            |
| `body.html`          | Final sanitized HTML fragment with typed app-owned placeholders             |
| `body.text`          | Plain text derived from that fragment and image alt text                    |
| `images`             | Ordered `{id, source_url, alt}` manifest items                              |
| `lead_image_id`      | Manifest ID copied into the list projection, or null                        |
| `integrity`          | `sha256` and lowercase digest of canonical envelope data without this field |

Each accepted body image becomes `<reader-image data-image-id="image-N"></reader-image>` in document
order. Publisher-supplied versions of that element or attribute are removed before placeholders are
created. Each placeholder maps to exactly one manifest item. A lead-only item may be the sole
unreferenced manifest record. Envelope v1 stores no image dimensions. Durable content stores no
signed imgproxy URLs.

The API bounds decompression, rejects duplicate JSON properties, dispatches by schema version,
verifies the integrity digest, and validates placeholder IDs, lead-image references, and public
image URLs before rendering. Unknown or corrupt content fails closed.

After successful processing, the worker discards source feed XML and unsanitized body HTML. Reader
does not fetch linked article pages. The API generates signed imgproxy URLs from the image manifest
at response time; they are not durable body data.

PostgreSQL never exposes a current content-object reference until the object is readable and passes
its integrity check. Retries are idempotent. Cleanup may remove staged or orphaned objects only
after the recovery window.

Identity and envelope versions never change meaning. Envelope writers emit only the current version;
rolling deployments add old-and-new readers before new writes begin. Backfills verify the old
object, write and verify a new object, and switch the reference through the normal publication
protocol. They never mutate an object in place. Existing identity keys remain immutable; a future
identity version requires dual lookup and explicit aliases before writers switch.

Article-list queries use the lead-image projection to generate signed thumbnails without loading
every body envelope. The projection follows the same image URL validation and content-version rules
as the manifest.

### Entry state

A sparse private user-to-entry record. Create this record only when its state differs from
subscription defaults or must survive independently.

Possible state:

- Explicitly read or unread exception
- Saved flag
- Coarse reading progress
- Last opened time

Avoid one row for every delivered user-entry pair.

### Fetch attempt

Records operational history for one feed request, including safe diagnostics such as outcome class,
duration, HTTP status, validators used, entries observed, and the next scheduling input. Logs and
tables must not become a second copy of feed bodies.

### Admin audit

An append-only record for every admin mutation.

Contains:

- Actor application user ID
- Action and target type
- Target ID
- Timestamp
- Request correlation ID
- Small allowlisted metadata without credentials, content, or secrets

## Read-state model

Unread state combines a per-subscription watermark with sparse entry exceptions.

### Subscribe or import

- Import currently available entries for browsing.
- Set the initial watermark so those entries begin read.
- Treat entries first observed after subscription as unread.

### Open

- Mark the entry read with a sparse exception when it is newer than the watermark.
- Keep the selected row in the current unread view until navigation leaves it.

### Mark unread

- Store an unread exception even when the entry lies behind the watermark.

### Mark scope read

- Advance the relevant subscription watermarks to the scope boundary.
- Remove sparse read exceptions made redundant by the new watermarks.
- Preserve saved and progress state.
- Keep enough mutation context for the product's temporary undo window.

Folder-wide and global mark-read operations update the member subscriptions rather than introducing
a second folder-level state model.

## Retention

| Data                     | Retention                                            |
| ------------------------ | ---------------------------------------------------- |
| Invitation request       | 30 days from submission                              |
| Ordinary sanitized body  | 90 days                                              |
| Ordinary entry metadata  | 90 days                                              |
| Saved body and metadata  | Until no user keeps the entry saved                  |
| Read/progress exceptions | While required by retained entries and product state |

Image-cache policy lives in [`security.md`](security.md). Backup and recovery policy lives in
[`deployment.md`](deployment.md).

Retention jobs run in bounded batches. Start with indexed unpartitioned entry tables and add native
partitioning only after measured query or cleanup behavior justifies it.

Retention removes ordinary metadata and its sanitized body together from the user's perspective. It
must not leave a bodyless ordinary entry visible through beta. Deleting expired ordinary content
must not remove an object still referenced by a saved item. Object Storage versioning provides a
short recovery window; lifecycle rules remove superseded or unreferenced versions after the recovery
period.

## Unsubscribe

When a user unsubscribes:

- Remove the subscription and ordinary private entry state for that feed.
- Preserve saved state and the metadata/content required to render saved items.
- Preserve the global feed and entries while other subscribers or retained saved items reference
  them.
- Garbage-collect globally orphaned data asynchronously after retention and recovery windows.

## Account deletion

Account deletion is immediate from the user's perspective.

Delete:

- Kratos identity and sessions
- Application user profile
- Invitations owned by or reserved for the user where policy permits
- Folders and subscriptions
- Private entry state and preferences
- User-identifying analytics links

Retain only globally shared public feed and entry records that have another valid reason to exist.
Admin audit data may retain the deleted actor's opaque ID without retaining identity traits.

## Export

Through beta, OPML export contains active subscriptions and folder structure using standard OPML
outlines. Reader does not export preferences, read state, saved items, reading progress, article
bodies, or image files.

## Open schema details

These details remain deferred to schema and fixture design:

- Primary-key representation
- Nested OPML flattening, naming collisions, and duplicate-feed placement
- Exact idempotent protocol that publishes a content reference only after its object is readable
- Index selection and partition thresholds
- Audit retention duration
- Undo representation and expiry
