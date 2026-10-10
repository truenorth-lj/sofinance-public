import { expect,it } from "vitest";
import { priorMinuteMark } from "./lp-price-evidence";
it("selects only a completed prior minute, with explicit age and no event-price claim",()=>{
 const bars=[[120,2,2,2,2,1],[180,99,99,99,99,1]];
 expect(priorMinuteMark(195,bars)).toMatchObject({priceUSDC:"2",ageSeconds:15,exactEventTimePrice:false});
 expect(priorMinuteMark(100,bars).priceUSDC).toBeNull();expect(priorMinuteMark(301,[[120,2,2,2,2,1]]).priceUSDC).toBeNull();expect(priorMinuteMark(NaN,bars).priceUSDC).toBeNull();
});
