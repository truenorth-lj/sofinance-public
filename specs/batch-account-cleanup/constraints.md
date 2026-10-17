# Constraints and evidence

- At most 64 unique wallet-derived source accounts per prepare request; existing request body limits remain enforced.
- Every serialized transaction is at most 1,232 bytes. One approval can cover multiple transactions through the wallet's batch signing capability; Solana finalizes each transaction independently.
- Blockhash expiry and rejected signatures can leave a partially completed inventory. Persist signed attempts before broadcast, confirm every signature, preserve successful chunks and rescan before a new batch.
- Never mark an unknown submitted signature unsent based on a timeout, fetch abort or HTTP 429.
- No funded wallet signatures or broadcasts are produced by automated verification. Fixtures use generated local keys; live evidence uses read-only account reads and unsigned transaction simulations.

Backend verification covers greedy packet packing, shared blockhashes, ATA deduplication, finalized absence, seed and recipient tampering, exact token/SOL deltas, independent permit domains, invalid signatures, uncertain submissions, finalized receipt reconstruction and transient confirmation failures. A read-only simulation of the reported wallet's remaining 12 sources produced one transaction of 1,166 bytes with a 5,000-lamport fee estimate and 78,398 simulated compute units.
