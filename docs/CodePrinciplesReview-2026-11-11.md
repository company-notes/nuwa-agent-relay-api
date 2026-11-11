# Code Principles review — Relay API — 2026-11-11

Basis: the exact uploaded `CODE_PRINCIPLES.md` (49,002 bytes, CRLF preserved;
Git blob `b4be09250ee3bd32e4adf8eb1d7b46e4939212c6`).

## Review 1 — full baseline inspection

Coverage: all tracked `src/*.ts`, `scripts/**/*.mjs`, Worker/D1 tests and
the repository development guidance. Inspected exception paths, unsafe
fallbacks, business/API boundaries, dynamic imports, unbraced JS/TS
conditionals, semantic spacing (Rule 20), misleading historical comments,
credential-bearing diagnostics and provider-resource deletion safeguards.

Findings:
- Wake registration and retry formerly suppressed transport exceptions;
  operational failures needed centralized, privacy-safe reporting.
- Smoke browser launch, callback handling and Wake listener had silently
  ignored or unobservable failures.
- The legacy `MailTriggerRouteProvisioner.ts` conditionals lacked braces;
  malformed resource IDs were treated as missing during some cleanup checks.
- `RelayAPI.handle` interleaved Wake and unrelated message routes.
- `MailReceipt.reconcileArchives` described polling by Cron that is not
  part of the current scheduled path.

## Review 2 — after first corrections

- Added shared, sanitized Worker/Smoke loggers; preserved retry behavior and
  improved error observability without logging credentials or target paths.
- Grouped Wake HTTP endpoints into `RelayAPI.routeWake`, leaving the public
  HTTP contract unchanged.
- Corrected the Archive diagnostic docstring and Rule 20 extra spacing.
- Removed raw exception-message logging from smoke CLI boundaries.
- The route-linked-ID fail-closed and braces regressions are kept in
  separate Draft PR #16 so production routing safety changes can be reviewed
  independently. PR #16 covers the reported one-line conditions in
  `MailTriggerRouteProvisioner.ts` and `RelayTestClient.ts`.
- Found a circular-import workaround in smoke `Shared.mjs` on deeper review.

## Review 3 — final source scan and CI

- Broke the Smoke OAuth circular dependency into `SmokeConfig.mjs` (neutral
  settings), `AuthStore.mjs` (token read/refresh/persistence),
  `Auth.mjs` (interactive OAuth) and `Shared.mjs` (test workflows).
- Explicitly reject redirected backend and OAuth-refresh requests with
  `redirect: 'manual'`; tests confirm credentials are not resent.
- Added a smoke logger privacy regression and retained the original
  assertion-based Worker, D1 and smoke test coverage.
- Rechecked each tracked JS/TS source and test for empty catches,
  unbraced controls, incidental local imports, sensitive exception
  messages and irrelevant code co-location. The remaining four
  `MailTriggerRouteProvisioner.ts` one-line conditions on this PR branch
  are addressed in **PR #16**, which passed independently.
- A delayed import in `scripts/smoke/ResumeCheck.mjs` is intentional test
  setup: environment variables must be set before the module's
  initialization. It is not used to work around a circular dependency.

Evidence:
- Wake regression originally red: Actions run 42950113695.
- Source and privacy fixes green: Actions run 42963952193.
- Resource-ID deletion regression red: Actions run 42951892270.
- Resource-ID deletion and braces fixes green: Actions run 42962573301.

## Boundaries and remaining work

This review does **not** claim end-to-end MailTrigger delivery, Cursor
callback execution, or proof that every clean-code principle is
mechanically enforceable. `MailTriggerRouteProvisioner.ts` (about 720
lines) and `RelayService.ts` (over 560 lines) are cohesive production
services but remain candidates for later tightly scoped internal class
extraction with dedicated tests. Avoid mixing those broader reorganizations
with credential delivery fixes or protected Route deletion.

Both PR #15 and PR #16 remain Draft; neither deploys until merged to
`main` with authorization.
