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

The open-position NFT mint is an ephemeral **client** keypair. `/api/open-prepare` accepts the mint public key and returns a fully unsigned transaction; the wallet signs first, then the client adds the mint signature on the wallet-returned message (Phantom may add Lighthouse / compute-budget instructions) and zeroes the secret. The server does not generate or hold that secret on the HTTP path. MCP `prepare_open_position` prefers the same flow when the agent passes `nftMint`; when it is omitted, `/app/sign/<token>` generates the mint in the browser, re-prepares through `/api/sign-open-prepare` with the HMAC-bound sign-token inputs, and adds the mint signature after the wallet. The server never generates or holds a mint secret on either path. See the README open-position notes and `@sofinance/engine` `open-atomic`.
