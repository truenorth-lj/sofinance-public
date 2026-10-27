# Delivery tracking

- [x] Preserve ambiguous send outcomes across retry/fallback boundaries.
- [x] Redact API console diagnostics and nested causes.
- [x] Repair E2E connection helper and build command.
- [x] Add production build/browser, PostgreSQL and environment-matrix CI gates.
- [x] Complete independent security, code and QA reviews; merge and verify phase 0.
  PR [#149](https://github.com/truenorth-lj/sofinance-public/pull/149) merged as `71157c4aef1024ef711aef64c9f930d1aaca1a15`; deployment identity and 9 production read-only checks verified on 2026-10-27.
- [x] Reconcile engine sources, migrate active ownership into public and verify its web/API/MCP consumers; leave prototype unchanged.
  Ownership migration merged in PR [#150](https://github.com/truenorth-lj/sofinance-public/pull/150) as `5a6bb9fd0d2b68ac6a6f8d039fc9fc4a70e001fd`; local integration, CI and production deployment identity plus 9 read-only checks verified on 2026-10-27. Prototype remains unchanged; real financial flows were not exercised.
- [x] Remove proven dead code and stale root lock; update architecture documentation.
  Root lock removal shipped with PR #150. Cleanup PR [#151](https://github.com/truenorth-lj/sofinance-public/pull/151) merged as `3a55c02bf70fef5c7a75c38cfc869dcc51730995`; production identity and read-only checks verified on 2026-10-27.
- [ ] Share HTTP/MCP use cases and tool registry with explicit policies.
  Metadata PR [#152](https://github.com/truenorth-lj/sofinance-public/pull/152) merged as `5ab102a4cd626cd627af0326555b0dc0feec6be2`; production identity, 9 read-only checks and complete 16-tool descriptor parity verified on 2026-10-27. Typed dispatch PR [#153](https://github.com/truenorth-lj/sofinance-public/pull/153) merged as `fae3acf952b39f4fa5df9a92c81a7b50ce9392bc`; production deployment `dpl_3pGPUtimaBWoXXLsxb9UHpEVe2iR`, 9/9 read-only checks (zero retries/skips), and all 16 full descriptors verified on 2026-10-27. Prepare extraction is implemented locally with frozen entrypoint baselines ([scope](transaction-prepare.md)); independent review and delivery remain pending. Selected-submit sharing remains incomplete.
- [ ] Decompose attempt state/controllers with behavioral coverage.
- [ ] Type store contracts and migrate analytics schema management.
