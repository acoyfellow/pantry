# Employee Pantry canary comparison receipt

- **Environment:** `https://pantry.ax.cloudflare.dev` only
- **Collection result:** blocked at Cloudflare Access before the Pantry Worker
- **Collection time:** 2026-08-17T09:19:21Z
- **Write operations:** none
- **Production D1 writes:** none
- **GitLab mutations:** none

## Access evidence

Read-only `GET` and `HEAD` requests to the Employee Pantry health, session, discovery, and approval-history route classes received HTTP 302 at the Cloudflare Access edge. The response indicates that a Cloudflare Access login is required; no Pantry Worker response or recipe data was received.

The exact blocker is: no authenticated Employee Pantry Access browser session or scoped Employee Pantry read credential was available to this child. The locally expected `agent-browser` executable is not installed, so this child cannot initiate an isolated browser-based Access login. Login redirect URLs, Access assertions, cookies, and credentials are deliberately omitted.

## Requested-artifact comparison

| Recipe | Current metadata | Immutable versions | Approval receipts | Attestations | Retrieval / usage counts | Authorship | Access state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `review_this_mr` | Not retrieved | Not retrieved | Not retrieved | Not retrieved | Not retrieved | Not retrieved | Unknown; Access-blocked |
| `reviews_todo` | Not retrieved | Not retrieved | Not retrieved | Not retrieved | Not retrieved | Not retrieved | Unknown; Access-blocked |

No comparison of versions, source digests, capability digests, approval receipt digests, attestation receipts, or access states is possible without a successful authenticated read. Empty arrays and `null` fields in `employee-canary-manifest.json` mean **unavailable because collection was blocked**, not evidence that Employee Pantry has no history or artifacts.

## Safe resumption procedure

Use an authenticated Employee Pantry Access session or a scoped `recipes:read` Employee Pantry credential, then issue only authenticated `GET` requests to the read-only discovery, pinned-recipe, approval-history, attestation, and audit/history APIs. Capture metadata and digests, not source text or credentials. Do not call retrieval endpoints that record access if the no-production-D1-write constraint remains in force.
