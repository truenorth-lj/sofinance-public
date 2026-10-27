# Delivery tracking

- [x] Preserve ambiguous send outcomes across retry/fallback boundaries.
- [x] Redact API console diagnostics and nested causes.
- [x] Repair E2E connection helper and build command.
- [x] Add production build/browser, PostgreSQL and environment-matrix CI gates.
- [x] Complete independent security, code and QA reviews; merge and verify phase 0.
  PR [#149](https://github.com/truenorth-lj/sofinance-public/pull/149) merged as `71157c4aef1024ef711aef64c9f930d1aaca1a15`; deployment identity and 9 production read-only checks verified on 2026-10-27.
- [ ] Reconcile engine sources, migrate active ownership into public and verify its web/API/MCP consumers; leave prototype unchanged.
  Ownership migration merged in PR [#150](https://github.com/truenorth-lj/sofinance-public/pull/150) as `5a6bb9fd0d2b68ac6a6f8d039fc9fc4a70e001fd`; local integration and CI passed. Production verification remains pending root confirmation; prototype remains unchanged.
- [ ] Remove proven dead code and stale root lock; update architecture documentation.
  Root lock removal shipped with PR #150. Dead-code cleanup and documentation are staged locally on that base; fresh independent review and merge are still pending.
- [ ] Share HTTP/MCP use cases and tool registry with explicit policies.
- [ ] Decompose attempt state/controllers with behavioral coverage.
- [ ] Type store contracts and migrate analytics schema management.
