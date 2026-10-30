import { defineConfig } from "drizzle-kit";

/** Opens analytics has a separate database and migration ledger from RWA. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/opens-schema.ts",
  out: "./drizzle-opens",
  strict: true,
  verbose: true,
});
