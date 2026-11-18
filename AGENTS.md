# Development guidance

Follow the checked-in [`CODE_PRINCIPLES.md`](CODE_PRINCIPLES.md) as the authoritative coding standard, adapted to this TypeScript Cloudflare Workers project. Test commands and integration boundaries are defined below.

## Coding

- Use camelCase for TypeScript identifiers and runtime JSON. Preserve the existing SQL column names and external API/URL query parameter contracts.
- Always use braces with JavaScript/TypeScript control-flow statements.
- Keep state and helpers in the class responsible for them. Prefer early returns and clear failure paths to deep nesting or silent fallbacks.
- **Rules #11–12:** report every caught operational exception through the shared `Logger` with event name and safe metadata. Never log credentials, callback paths, raw network error messages or request bodies. Rethrow at ownership boundaries unless a failed attempt is explicitly represented and observable.
- **Rule #14:** use braces on separate lines for all TypeScript/JavaScript control statements.
- **Rule #20:** use one blank line between meaningful phases (authentication, validation, persistence, transport and response). Keep related statements together, and keep `if/else` and `try/catch/finally` contiguous. Never insert a blank line after every `if` automatically.
- Do not change public routes, database schema or secrets handling as part of a formatting-only change.

## Tests

This is a Cloudflare Workers API, not a Django project. Use the actual Worker runtime and isolated D1 with Vitest. The real user-facing entry point is HTTP, and the focused API flow is in `test/CoreFlow.test.ts`. There is no interactive web UI requiring browser automation in this repository.

```bash
npm ci
npm run check
npm run test:core
npm test
node --check scripts/prepare-deploy.mjs
```

- Keep the transport, user identities and shared actions in `test/RelayTestClient.ts`; individual test files should express scenarios and assert response status, payload and stored D1 state.
- Cover distinct branches only: `Alias.test.ts`, `Handoff.test.ts` and `Errors.test.ts` should not duplicate the focused core flow.
- For a real bug, write the assertion first, run it **red** for the expected assertion failure, apply the smallest fix, and rerun **green** plus the full suite. Include both results in the PR.
- Use external test doubles only for Agent Address and MailTrigger when isolated test accounts are unavailable. Do not present a mocked external delivery as a real end-to-end delivery test.
- Live integrations should be environment-gated and must never send test traffic to production mailboxes or write to production D1.

## Deployment

Create a PR for refactors, run CI, then merge only when tests pass and production rollout is authorized. A verified push to `main` triggers the production deployment workflow; draft PR branches do not deploy. When GitHub Actions is unavailable, test the proposed merge and deploy only the verified, merged `main` commit from the local environment after rollout authorization. Never print secrets, reuse the Agent Address database, or treat a successful Wrangler deploy as proof that a real message was delivered.
