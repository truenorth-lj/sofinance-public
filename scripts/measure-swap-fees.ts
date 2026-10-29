// Offline only: no connection, wallet secrets, quote requests, or submissions.
import { feeSizeFixtures } from "../src/lib/swap/size-fixtures";
process.stdout.write("Complete v0 packets, including signatures; limit 1232 bytes\n");
for (const row of feeSizeFixtures()) {
  process.stdout.write(`${row.flow}: ${row.bytes} bytes (${row.fits ? "fits" : "oversized"}; serialized=${row.serialized})\n`);
}
