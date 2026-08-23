# 0005: Yandex Cloud with transient blue-green VMs

Status: Accepted

## Context

The hosted beta is self-funded and targets `ru-central`. It should keep the application portable
while using a managed service for database operations. A single mutable VM is cheap, but it makes
rollback and release verification fragile.

## Decision

Deploy to Yandex Cloud `ru-central` with Managed PostgreSQL, Object Storage, Lockbox, Postbox, a VPC
Object Storage service connection, Network Load Balancer, and one application VM during normal
operation. Run rootless Podman Compose on that VM. Put Cloudflare Free in front of the public reader
and `reader.mprvr.net`, which serves end-user assets and signed image responses. Use Yandex Bastion
for the private admin application and admin asset origin.

Store end-user and admin browser releases in private Object Storage rather than on application VMs.
Nginx proxies release reads as defined by [ADR 0006](0006-static-spa-delivery.md). Route all hosted
Object Storage traffic through the VPC service connection. Content objects continue to require
application authentication; only bounded browser-release reads use endpoint-conditioned anonymous
access.

For each release, create a transient green VM with OpenTofu and apply expand-only migrations. Verify
the green VM, then promote it through the Network Load Balancer after manual approval. Retain blue
for 24 hours, then destroy it. Contract the schema in a later release.

## Consequences

- Releases require backward-compatible schemas and explicit migration jobs.
- Compute cost temporarily doubles around deployment. It does not double during normal operation.
- The load balancer provides Cloudflare with a stable origin and switches traffic based on health
  checks.
- Browser-release reads remain inside the VPC and require no runtime storage credential.
- Browser releases survive VM replacement and blue destruction; they have their own bounded
  retention and cleanup process.
- Provider-specific infrastructure remains outside the portable application and Compose interfaces.
- The spend review policy in `docs/deployment.md` bounds growth.
