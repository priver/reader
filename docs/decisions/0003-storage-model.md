# 0003: Split transactional state and content bodies

Status: Accepted

## Context

At the planned scale of 1,000 users, 25,000 unique feeds can produce millions of retained entries
and tens of gigabytes of sanitized bodies. Reader does not search body text through beta. Creating
one state row for every user-entry pair would multiply storage further.

## Decision

Use Managed PostgreSQL for transactional metadata, ownership, sparse user state, jobs, and audit
records. Use private Yandex Object Storage for compressed, versioned sanitized feed-body envelopes.
Share public feeds and entries globally while keeping subscriptions and state private.

[ADR 0008](0008-entry-content-contracts.md) defines feed-scoped entry identity and the versioned
envelope format. Object publication and recovery follow a separate coordination protocol because
PostgreSQL and Object Storage do not share a transaction.

This content bucket is separate from the Object Storage buckets that hold reproducible browser
release artifacts under [ADR 0006](0006-static-spa-delivery.md).

In the hosted deployment, restrict the content bucket to the Object Storage VPC service connection
and continue to require authenticated API and worker access. Network reachability alone never grants
content-object reads. Do not grant content-bucket roles to a VM-wide identity available to Nginx;
give the API and worker separate identities or credentials. The API may only get content envelopes.
The worker may get, put, and delete envelopes for ingestion and retention. Neither identity may list
the bucket or administer its policy or configuration.

Retain ordinary entry metadata and sanitized body envelopes for the same 90-day window. Preserve
both beyond that window while at least one user keeps the entry saved.

Represent unread state with per-subscription watermarks and sparse entry exceptions. Start with
indexed unpartitioned entry tables. Add partitioning only when query or cleanup measurements justify
it.

## Consequences

- Normal reads access PostgreSQL and Object Storage, so the API uses ETags and a bounded body LRU.
- Object writes and metadata changes do not form one ACID transaction. They require explicit failure
  recovery.
- Retention coordinates PostgreSQL metadata removal and Object Storage cleanup without exposing
  bodyless ordinary entries.
- Saved-reference checks and Object Storage lifecycle policy protect retained bodies and metadata.
- Reader deduplicates public feed fetching and storage across users. It does not expose which users
  follow each feed.
