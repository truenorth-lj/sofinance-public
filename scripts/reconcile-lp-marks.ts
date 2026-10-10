// Offline provenance/coverage report. Run with --conditions=react-server.
import {join} from "node:path";
import {writeFile} from "node:fs/promises";
import {readCapturedHistoricalMarks} from "../src/lib/lp-historical-marks";
async function main(){
const report=await readCapturedHistoricalMarks();
await writeFile(join(process.cwd(),"specs/lp-decision/fixtures/public-historical-mark-audit.json"),JSON.stringify(report,null,2));
console.log({requiredMarks:report.requiredMarks,availableReferenceMarks:report.availableReferenceMarks,exactEventTimePrices:report.exactEventTimePrices,missing:report.rows.filter(r=>r.status!=="reference-mark").map(r=>({timestamp:r.timestamp,mint:r.mint,reason:r.reason}))});

}
void main().catch(error=>{console.error(error);process.exitCode=1;});
