# Batch leftover-account cleanup

A connected wallet can consolidate all discovered compound leftovers through one wallet approval. Preparation packs as many validated sources as fit into each Solana transaction. If the inventory needs multiple transactions, the wallet signs the complete array once; transaction submission and confirmation remain individually observable and resumable.

A successful cleanup transfers each source's exact raw token amount to the connected wallet's canonical ATA and closes the source back to that wallet. Previously closed sources are skipped only after finalized absence. Already finalized successful chunks remain successful across refreshes and transient RPC errors.

Preparation accepts at most 64 sources. No service key signs the wallet's transactions. Wallets without a batch signing capability receive an explicit unsupported message when more than one transaction is necessary, rather than a sequence of approval prompts.
