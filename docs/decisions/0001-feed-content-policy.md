# 0001: Use feed-provided content through beta

Status: Accepted

## Context

Reader focuses on reading quality. Downloading linked pages would add a separate network fetch path.
It would also require handling publisher restrictions, variable extraction quality, more
infrastructure, and a second sanitizer or content service. The initial product can validate its
reading workflow with content that publishers intentionally include in RSS and Atom.

## Decision

Through invitation beta, store and render only article HTML supplied by RSS or Atom. Normalize and
sanitize that HTML in the Go worker. When a feed supplies only an excerpt, show it and provide an
open-original action.

After beta, research must revisit the problem before the project creates a linked-page fetcher,
readability service, extraction contract, extraction job, or extraction-specific storage model.

## Consequences

- The alpha fetches feeds and bounded website HTML for feed discovery through one hardened Go
  network client.
- Some publishers' feeds provide incomplete in-app reading experiences.
- Sanitization remains required because feed HTML is untrusted.
- Because this decision creates no extraction service boundary, post-beta research can design one
  from evidence gathered then.
