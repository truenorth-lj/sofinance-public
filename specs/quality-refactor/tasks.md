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
  Metadata PR [#152](https://github.com/truenorth-lj/sofinance-public/pull/152) merged as `5ab102a4cd626cd627af0326555b0dc0feec6be2`; production identity, 9 read-only checks and complete 16-tool descriptor parity verified on 2026-10-27. Typed dispatch PR [#153](https://github.com/truenorth-lj/sofinance-public/pull/153) merged as `fae3acf952b39f4fa5df9a92c81a7b50ce9392bc`; production deployment `dpl_3pGPUtimaBWoXXLsxb9UHpEVe2iR`, 9/9 read-only checks (zero retries/skips), and all 16 full descriptors verified on 2026-10-27. Prepare PR [#154](https://github.com/truenorth-lj/sofinance-public/pull/154) merged as `5150cdf60d9be719c553b05b241df30dd8d932a6`; root separately verified deployment `dpl_HMvswA5Mguo11dq9qouEY4dRKv8w`, 9/9 read-only checks (zero retries/skips), and all 16 full descriptors on 2026-10-27 ([prepare scope](transaction-prepare.md)). Selected-submit RPC sharing ([scope](selected-submit.md)) shipped in PR [#155](https://github.com/truenorth-lj/sofinance-public/pull/155), merge `f9004515b2dfcd6ac30f093b795d510ce53f6b16`. Root verified production `dpl_HyW6iotNKLmySa87f5aVVhK6h4XQ`, 9/9 read-only checks (zero retries/skips) and all 16 full tool descriptors on 2026-10-27; these are prior delivery receipts, not lifecycle-fix release evidence. The full shared-usecases phase is not globally delivered.
- [ ] Decompose attempt state/controllers with behavioral coverage.
  Standalone selected-add lifecycle safety fix D1 is implemented locally with real-hook RED/GREEN coverage ([scope](selected-lifecycle.md)); independent review, CI and delivery remain pending. Controller decomposition and Withdraw D2/D3 remain separate, unfinished work.
- [ ] Type store contracts and migrate analytics schema management.
