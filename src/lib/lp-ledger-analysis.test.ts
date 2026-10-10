import {expect,it} from "vitest";
import {historySnapshotMatches} from "./lp-ledger-analysis";
it("rejects fee-only history head change even when liquidity is unchanged",()=>{
 expect(historySnapshotMatches("before-claim",[{signature:"after-claim"}])).toBe(false);
 expect(historySnapshotMatches("same",[{signature:"same"}])).toBe(true);
});
