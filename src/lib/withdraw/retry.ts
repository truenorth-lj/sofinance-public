/** Messages from the post-build re-simulation that only mean the chain moved between our two reads. */
export const TRANSIENT_BUILD_ERRORS = [
  "Withdrawal received below simulated minimum",
  "Wallet token balance changed; prepare again",
  "Cannot calculate transaction network cost",
  "Unable to estimate complete transaction network fee",
];

/** Rebuild from scratch (every build re-reads chain state) when the re-check saw the chain move. */
export async function withTransientRetry<T>(build: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await build();
        }
        catch (error) {
            if (attempt >= attempts || !(error instanceof Error) || !TRANSIENT_BUILD_ERRORS.includes(error.message))
                throw error;
        }
    }
}
