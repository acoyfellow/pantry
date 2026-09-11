# MCP SSO implementation plan

## Result

**Feasible, but not implemented.** The repository has a deliberate boundary for a future browser-session transport, not an OAuth client or a browser-login protocol. A safe implementation must choose one of these supported product boundaries before code is written:

1. **Preferred: broker browser SSO through the Pantry Worker.** The Worker is the confidential OAuth 2.1 client and maintains a Pantry session for the local CLI/MCP server. It integrates the selected enterprise issuer with authorization code plus PKCE.
2. **Access-compatible alternative: rely on Cloudflare Access as the browser gate and use its approved programmatic authentication mechanism.** This is viable only after the Access application, protected paths, token-validation method, and local-client handoff are explicitly confirmed. Access edge identity headers are not available to a local stdio process by themselves.

Do not treat `PANTRY_TOKEN`, the local `~/.terrarium/pantry-token.secret`, browser cookies, or a copied `Cf-Access-Authenticated-User-Email` value as employee SSO credentials. Existing values are either automation credentials or edge-injected request metadata.

## Evidence

### Current MCP and CLI behavior

- `src/mcp.ts` is a four-tool **stdio** MCP server. It has no HTTP transport, OAuth discovery endpoint, callback listener, or browser launcher.
- `src/cli.ts` reserves `pantry login`, but it only reports that browser SSO handoff is unavailable. `pantry mcp` calls the same `makeClient()` factory as the CLI.
- `src/surface.ts` loads an explicit automation secret from `PANTRY_TOKEN` or `~/.terrarium/pantry-token.secret`; it does not acquire, refresh, or store a browser session.
- `src/client.ts` has two transport shapes: an `automation-token` bearer header and caller-supplied `session` headers. The latter is an injection seam, not a session implementation.
- `docs/MCP.md` correctly states that OAuth and PKCE are not implemented and that stdio hosts currently require a provisioned automation credential.

### Current Worker and Access behavior

- `src/worker.ts` trusts the configured request header `cf-access-authenticated-user-email` by default, or `PANTRY_ACCESS_IDENTITY_HEADER`, only when `PANTRY_ACCESS_SHARE_ALL === "true"` and an identity is present. It assigns every such request to `PANTRY_SHARED_OWNER` and requires a same-origin request.
- `wrangler.ax.jsonc` configures `PANTRY_ACCESS_SHARE_ALL=true`, `PANTRY_ACCESS_ONLY=true`, and `PANTRY_SHARED_OWNER`; it does **not** define an OAuth issuer, OAuth client, callback, cookie signing key, Access application, Access policy, Access team, or protected-path policy. Wrangler configuration cannot establish those external Access settings.
- The public configuration (`wrangler.jsonc`) has no Access settings. Both configurations currently route a custom domain and run the Worker first for `/health`, `/recipes*`, `/recipe/*`, and `/api/*`.
- `PANTRY_ACCESS_ONLY=true` rejects legacy bearer authentication after no Access identity is found. Agent credentials are D1-backed bearer credentials with scopes; their create, rotate, and revoke management routes require an Access identity.
- `migrations/0007_agent_credentials.sql` supports hashed long-lived agent credentials and revocation, not browser OAuth sessions, authorization codes, refresh tokens, or OAuth grants.
- The Worker does not validate an Access JWT. Its trust boundary is therefore the Access edge correctly protecting every route that can reach this Worker and stripping/replacing spoofable identity headers before origin delivery.

### Existing authorization model

- Machine credentials are limited to `recipes:read`, `recipes:write`, and `usage:report`. They cannot access `/api/*` management routes or approvals.
- Access-authenticated requests currently gain a shared owner and can reach management and approval endpoints. The code does not distinguish user roles; every Access identity admitted by the edge can perform approval and credential-management actions for the shared owner. This must be corrected before broad employee SSO rollout.
- CORS permits a reflected origin and browser preflight; management requests are additionally same-origin only in the Access-share-all branch. CORS must not be used as authentication or as a substitute for CSRF protection.

## Recommended target design: Worker-brokered OAuth 2.1 authorization code with PKCE

This is the recommended design if an approved OpenID Connect/OAuth issuer is available. It keeps issuer client authentication, token exchange, token refresh, and employee tokens out of a local MCP process and out of MCP host configuration.

### Actors and trust boundaries

- **Local CLI/MCP process:** launches a user browser, runs a short-lived loopback listener, receives only a one-time opaque handoff result, and stores only a Pantry session reference in an OS credential store.
- **Pantry Worker:** OAuth confidential client, callback recipient, session issuer, authorization policy enforcement point, and BFF for browser/CLI session exchanges.
- **Browser:** follows redirects to the selected issuer and returns to a registered Worker callback. It does not receive a Pantry agent credential.
- **Enterprise issuer:** authenticates the employee and returns an authorization code. Its issuer URL, JWKS, claims, consent requirements, and token lifetime must come from approved metadata/configuration rather than being hard-coded.
- **Access edge:** remains the policy gate for the Operations browser app, if retained. It must protect the Worker endpoints chosen below, and it must not be confused with the OAuth issuer unless the organization confirms that it supplies the required OAuth/OIDC role.

### Proposed routes

Route names below are proposed repository routes, not deployed endpoints. Register their exact HTTPS callback URI only after the deployment origin is selected.

| Route | Purpose | Required properties |
| --- | --- | --- |
| `GET /api/auth/login` | Begins browser login. | Creates a one-use transaction, validates a requested local loopback return target against an allowlist, creates `state`, nonce, PKCE verifier/challenge, then redirects to issuer authorization. |
| `GET /api/auth/callback` | Receives the issuer authorization response. | Exact registered redirect URI; validates transaction expiry, state, nonce, issuer, code, and PKCE exchange result; does not expose upstream tokens to the browser or CLI. |
| `POST /api/auth/handoff` | One-time local CLI exchange. | Accepts an opaque handoff code plus the original local transaction binding; returns a short-lived Pantry session credential only once. Require proof that the request is the initiating local client, not merely possession of an URL. |
| `POST /api/auth/refresh` | Rotates a valid local Pantry session. | Uses an HttpOnly browser session or server-side refresh state; rotate session identifiers and reject replay. Do not issue refresh tokens to MCP host config. |
| `POST /api/auth/logout` | Revokes the Pantry session and clears browser session state. | Server-side revoke plus cookie clearing; optionally starts issuer/Access logout only if supported and approved. |
| `GET /api/session` | Current-session inspection. | Continue returning a minimal principal/session/authorization view, never raw issuer or refresh tokens. |

A loopback callback is appropriate for a locally invoked `pantry login`, but it should receive a short-lived one-time result generated by the Pantry Worker rather than an issuer token. Use a dynamically selected loopback port only if the issuer permits loopback redirect patterns; otherwise use a device-authorization flow **only if the selected issuer supports it and security approves it**. Do not invent a device endpoint.

### Authorization request and callback checks

1. The CLI generates a high-entropy local transaction identifier and starts its listener before opening the browser.
2. The Worker creates a transaction record with: random `state`, OIDC `nonce` when applicable, PKCE `code_verifier` or encrypted verifier, `code_challenge` using `S256`, requested scopes, local return binding, creation time, and a short expiry.
3. The Worker sends an authorization request using authorization-code flow, PKCE `S256`, exact redirect URI, `state`, and `nonce` where OIDC is used. Request only the identity claims needed for authorization.
4. The callback verifies `state` atomically and consumes the transaction. It exchanges the code server-to-server, validates issuer/audience/signature/expiry/nonce according to issuer metadata, and maps an immutable subject plus approved identity claims to Pantry principal and role.
5. The callback creates a short-lived, opaque Pantry session and a single-use handoff code bound to the transaction and loopback listener. It redirects only to the validated local target.
6. The local process exchanges the handoff code once, stores the returned Pantry-session material in the OS credential store, and begins MCP stdio. It must not print any secret to stdout because stdout is the MCP protocol channel.

### Session, token, and storage policy

- Store OAuth transaction state, authorization codes, token metadata, session IDs, refresh-token ciphertext if retained, principal mapping version, scopes/roles, expiry, revocation time, and rotation lineage in a server-side durable store. D1 is suitable only after a migration, encryption/key-management decision, retention policy, and concurrency/replay design are approved.
- Store issuer access/refresh tokens only when the chosen flow requires them. Encrypt at rest with a managed secret/key reference; never store plaintext in D1, Worker variables, logs, recipe records, MCP messages, or browser storage.
- Prefer an opaque Pantry session token. For browser use, send it as `Secure`, `HttpOnly`, `SameSite=Lax` (or stricter after callback compatibility is tested), path-scoped cookie. For the local CLI, store an opaque session/refresh reference in the operating-system credential manager with restrictive file fallback only if explicitly approved.
- Do not reuse `~/.terrarium/pantry-token.secret` for browser SSO. Preserve it for explicitly provisioned automation compatibility credentials. Add a distinct credential namespace/name for a user session.
- Access tokens presented to the Worker must be accepted only over TLS, never logged, redacted in errors, and never included in MCP tool responses. The MCP server must send session data in headers supplied by a credential provider, not in tool arguments.
- Use short access/session lifetimes, absolute session expiry, idle expiry, refresh rotation, one-time handoff codes, and replay detection. Values are policy decisions to set with Security, not hard-code in this phase.

### Pantry scopes and authorization

Separate issuer login scopes from Pantry API authorization:

- **Issuer/OIDC scopes:** request the minimal approved identity set (normally identity plus email/profile only if those claims are required). Exact scopes must come from issuer metadata and the identity/authorization design.
- **Pantry user permissions:** introduce server-enforced roles/permissions, for example management read, recipe write, credential administration, and approval decision. Do not grant all of these merely because Access authenticated an employee.
- **Agent credential scopes:** retain `recipes:read`, `recipes:write`, and `usage:report` for non-interactive agents. They are not OAuth scopes and must remain incapable of management/approval routes.
- Bind every Pantry session to immutable issuer subject, issuer identifier, principal mapping, role/version, session ID, and issuance/expiry timestamps. Email is mutable and should not be the sole durable identity key.

### Revocation and logout

- Local logout revokes the current Pantry session, removes the local credential-store entry, and clears browser cookies.
- Credential/role removal, issuer account disablement, Access policy changes, and manual administrator revocation must invalidate all matching Pantry sessions server-side. Consult the issuer on refresh and/or use its supported revocation/event mechanism; do not assume a JWT remains valid after an employee is removed.
- Preserve the existing agent credential rotation/revocation API separately. It must not revoke browser sessions by hash collision or identifier reuse.
- Audit authentication events, handoff redemption, refresh rotation/replay, logout, role changes, and revocation with session IDs and stable principal IDs, but never with raw codes or tokens.

## Access-compatible implementation option

Choose this only after the Cloudflare Access owner confirms the supported programmatic login and token-validation model for the Pantry application.

1. Configure Access to protect the Operations browser routes and every Worker API route that trusts the Access identity header. Verify that unauthenticated requests cannot reach the Worker with a user-controlled identity header.
2. Make the Access application policy the first authorization gate, but add Pantry role authorization after Access authentication. The current `PANTRY_ACCESS_SHARE_ALL` behavior is sufficient only for a tightly controlled shared demo, not for privileged multi-user approval/credential administration.
3. For browser management, rely on Access-managed browser session cookies and edge-injected identity only on the protected same-origin application. Keep browser cookies inaccessible to the Svelte UI.
4. For local MCP, use the specific Access-supported non-browser mechanism selected by the Access owner, or put the Worker-brokered OAuth handoff in front of the same Access policy. Do not ask a user to copy an Access cookie/header into `PANTRY_TOKEN`.
5. If validating an Access JWT in Worker code becomes necessary, obtain the approved issuer/audience/JWKS and rotation behavior from Access configuration. Do not accept arbitrary bearer JWTs or use an email header as a JWT substitute.

## Required external configuration and decisions

Before implementation, obtain and record (outside source control where secret):

1. The chosen identity system: issuer discovery metadata, approved OAuth/OIDC client type, authorization/token/revocation/logout capabilities, supported PKCE and loopback/device flow behavior, claim contract, and consent policy.
2. The exact production and development origins plus exact registered callback URI/URIs. No endpoint is asserted by this plan.
3. OAuth client registration, client secret/key management if a confidential Worker client is chosen, redirect URI approval, permitted post-login return targets, and secret rotation owner.
4. Cloudflare Access application configuration: protected hostname/path coverage, identity provider/policy, service-token policy if used for a separate machine boundary, and proof that the Worker cannot receive spoofed Access identity headers.
5. A durable principal-to-Pantry-role/team mapping, authorization administrator model, employee offboarding/revocation SLA, session TTL/idle/absolute lifetime, audit retention, and incident response owner.
6. Key-management choice for any server-side token encryption, D1 migration approval, data retention/deletion requirements, and staging/test tenant or issuer configuration.
7. MCP host support matrix: browser launch availability, loopback listener policy, OS credential-store implementations, headless/remote environments, and fallback behavior for non-interactive agents.

## Implementation sequence

1. Resolve the external decisions above and write an auth threat model. Explicitly choose Worker-brokered OAuth or Access-compatible authentication; do not implement both opportunistically.
2. Restore/introduce server-enforced identity-to-role/team authorization. Gate approval and credential management with explicit privileged roles; make shared-owner behavior an intentional, least-privilege deployment mode.
3. Add a migration for OAuth transactions, opaque sessions, one-use handoffs, refresh rotation/revocation state, and audit metadata. Include indexes and transactional consume/update semantics.
4. Implement Worker auth routes, transaction state/PKCE handling, issuer metadata validation, callback validation, session creation, logout/revocation, and redacted structured errors.
5. Implement a CLI credential provider and `pantry login` browser/loopback orchestration. Make `pantry mcp` use it only when a valid user session exists. Keep automation token behavior explicit and unchanged for non-interactive use.
6. Update MCP/CLI documentation and configuration examples to distinguish employee SSO sessions, Access browser sessions, and agent credentials. Never include a real access token, cookie, or callback secret in examples.
7. Roll out first to a staging Access application/issuer client, test revocation and offboarding, then obtain security review before production enablement.

## Test plan

### Unit tests

- PKCE challenge uses `S256`; random state/nonce/verifier meet entropy and length requirements.
- State/nonce mismatch, expired transaction, duplicate callback, duplicate handoff redemption, wrong loopback binding, invalid return target, and authorization-code exchange failures fail closed without token leakage.
- Issuer validation rejects wrong issuer/audience/signature/expiry/nonce and respects key rotation behavior in the configured verifier.
- Opaque session lifecycle covers expiry, idle timeout, rotation, refresh replay, logout, bulk principal revoke, role changes, and simultaneous requests.
- Existing agent credential scope/rotation/revocation behavior remains unchanged and cannot access browser or management session endpoints.
- Access header behavior rejects missing/untrusted/spoofable identity and privileged paths require a Pantry role, not merely an email.

### Worker integration tests

- Test all new routes against `FakeD1` or an isolated D1 database with deterministic clock/randomness seams.
- Verify public machine API, Operations browser app, and local session endpoints have the expected distinct authentication modes.
- Verify same-origin, CSRF, redirect allowlist, CORS preflight, cookie attributes, and cache-control headers. Authentication responses must be `no-store`.
- Verify every protected Worker-first route is covered by the intended Access policy in a deployment/configuration test or documented release checklist.

### CLI and MCP tests

- `pantry login` starts a listener, opens only an approved authorization URL, handles cancellation/timeouts, and never writes secrets to stdout/stderr logs.
- Session credential provider reads/writes only its dedicated secure storage and distinguishes unavailable interactive login from unavailable automation credentials.
- `pantry mcp` can call all four tools with a valid user session, handles expired/revoked sessions with an actionable re-login error, and does not attempt a browser flow for headless non-interactive automation.
- Preserve the current explicit `PANTRY_TOKEN` path for agent credentials and verify it cannot be mislabeled as SSO.

### End-to-end/security tests

- Run against an approved staging issuer/Access application: initial login, existing browser SSO, MFA/conditional-access challenge, denied policy, logout, issuer logout if supported, account disablement, role removal, and Access policy removal.
- Use browser automation only against the staging deployment to validate callback, cookie flags, management authorization, and logout. Exercise a separate CLI/MCP local handoff.
- Conduct abuse cases: callback mix-up, authorization response injection, CSRF, open redirect, local-port race, token/code replay, stolen session replay, Access-header spoofing at origin, and removal of a user while a session is active.

## Blockers

1. No selected OAuth/OIDC issuer, issuer metadata, registered client, approved callback URI, or Access programmatic-login decision is present in this repository.
2. No Worker auth/session/callback routes, D1 schema, token encryption/key management, or client credential-store implementation exists.
3. The current Access edge-header trust requires verified external route protection; this cannot be proven from Wrangler files alone.
4. `PANTRY_ACCESS_SHARE_ALL` maps every admitted Access identity to a shared owner and current code permits those identities to manage credentials and approve recipes. That is not an adequate employee authorization model.
5. Existing documentation has stale statements about `PANTRY_ACCESS_PRINCIPALS`, `PANTRY_ACCESS_TEAMS`, and team-role enforcement that do not match the current Worker implementation. Reconcile it before treating the repository as an operational runbook.

## Must fix before implementation or rollout

- Select and security-review exactly one user-login architecture and its external configuration; do not infer issuer endpoints or Access behavior.
- Replace broad Access-share-all privilege with stable-subject mapping and explicit least-privilege Pantry roles for credential management and approvals.
- Make Access route protection and origin header handling deploy-time, testable requirements. Fail closed if the expected Access evidence is absent.
- Define session/token encryption, secret rotation, redaction, audit, revocation/offboarding, and credential-store policies before storing any user session material.
- Add the session/auth migration and replay-safe transactional semantics before adding callbacks.
- Reconcile README and deployment docs with actual config/behavior, then add the unit, integration, CLI/MCP, staging, and security test coverage above.
