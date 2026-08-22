# 0002: Self-host Ory Kratos

Status: Accepted

## Context

Reader needs invitation-gated registration, multi-user ownership, email bootstrap and recovery,
preferred passkeys, later Google linking, account deletion, and portable open-source deployment.
Building these security-sensitive credential flows in the application would make the Go backend own
credential and account security.

## Decision

Self-host Ory Kratos beside the application. Send one-time codes through Yandex Cloud Postbox for
email bootstrap and recovery. Let authenticated users add passkeys, then prefer passkeys for login.
Add Google linking in beta only through an authenticated settings flow.

Keep the invitation gate in the Reader application. Reader accepts public email-only invitation
requests, requires administrator approval, and validates a single-use invitation before registration
completes. Kratos remains responsible for the resulting identity, credentials, and browser session.

Serve the private admin application at `admin.reader.priver.org`. Use `reader.priver.org` as the
WebAuthn relying-party ID so an enrolled Reader passkey is valid at both application origins. Keep
their browser sessions separate with host-only cookies and require the application admin role for
every admin operation.

The Go API validates Kratos browser sessions directly and maps the Kratos identity ID to an
application user. It does not issue a second application JWT.

## Consequences

- Kratos becomes a stateful deployed dependency with its own migrations and database.
- The React app renders custom Kratos browser flows in the Reader interface.
- Invitation requests, administrator approval, and invitation audit data remain application state.
- Public and admin browser sessions authenticate separately even though they use the same identity
  and WebAuthn relying-party ID.
- Returning users with passkeys still need working email delivery for recovery.
- Credential linking requires explicit authenticated action; matching email alone never merges
  identities.
