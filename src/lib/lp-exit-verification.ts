import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
export function verifiedTokenAmount(data:string|undefined,owner:PublicKey,mint:PublicKey,program:string){
 if(!data||![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(program))throw new Error("Token simulation data/program missing or invalid");
 const bytes=Buffer.from(data,"base64");
 if(bytes.length<72||!new PublicKey(bytes.subarray(0,32)).equals(mint)||!new PublicKey(bytes.subarray(32,64)).equals(owner))throw new Error("Token simulation mint/owner/data invalid");
 return bytes.readBigUInt64LE(64);
}
export function cleanExitDeltas(tokenDeltas:string[],nativeDelta:bigint,closedLamports:(number|undefined)[],convertRent:boolean){
 return tokenDeltas.length>0&&tokenDeltas.every(v=>v==="0")&&(!convertRent||nativeDelta===0n)&&closedLamports.length===3&&closedLamports.every(v=>v===0);
}
