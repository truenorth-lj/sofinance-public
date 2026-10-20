# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main` (unreleased tip) | Yes |
| `v0.1.x` | Yes |

Older tags, if any are published later, are unsupported unless listed here.

## Reporting a vulnerability

Please report vulnerabilities **privately**. Do not open a public issue, pull request, or discussion for a security problem.

Prefer GitHub **private vulnerability reporting** / **Security Advisories** on this repository:

- [Report a vulnerability](https://github.com/truenorth-lj/sofinance-public/security/advisories/new)

Include the affected version or commit, what is impacted, and enough detail to reproduce. Do not attach user keys, mnemonics, or live API credentials.

You should hear back in about **5 business days**. If the report is accepted, we will work on a fix and credit you if you want that. If it is declined, we will say why.

## Scope

In scope for this repository:

- the Next.js web app (landing, `/app`, `/docs`)
- App Router API routes (`/api/*`), including remote MCP (`/api/mcp`)
- the MCP stdio server (`src/mcp/`)
- transaction quoting, building, simulation, HMAC permits, and broadcast (`src/lib`, `@sofinance/engine`)

Out of scope: third-party programs and APIs (Raydium, Jupiter, wallets, RPC providers), infrastructure you run yourself, and social-engineering of users. This project has not published a security audit; please do not treat this file as one.

## Non-custodial model

The server never holds user private keys. Users (or their agent, locally) sign every transaction. Broadcast re-checks an HMAC permit and re-simulates before send.

The open-position NFT mint is an ephemeral server-side keypair: it partial-signs the v0 message after the fresh blockhash restamp, then the secret is zeroed in memory and is not logged or persisted. The wallet remains the fee payer. See the README open-position notes.

The transaction engine ships as a bundled package (`@sofinance/engine`, `vendor/sofinance-engine-0.1.0.tgz`) and is not covered by this repository's MIT license. The flow stays non-custodial and verifiable on Solscan: every transaction is signed by the user's wallet and can be inspected on-chain.
