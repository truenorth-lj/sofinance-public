import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect,it } from "vitest";
it("withdraw user-facing strings use beginner language",()=>{
 const source=ts.createSourceFile("withdraw-panel.tsx",readFileSync(new URL("./withdraw-panel.tsx",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const text:string[]=[];
 function visit(node:ts.Node){
  if(ts.isJsxText(node))text.push(node.text);
  // Include error/progress/button copy; exclude the HTML slider type.
  if(ts.isStringLiteral(node) && !(ts.isJsxAttribute(node.parent) && node.parent.name.getText(source)==="type"))text.push(node.text);
  ts.forEachChild(node,visit);
 }
 visit(source);
 expect(text.join(" ")).not.toMatch(/\b(liquidity|range|LP)\b/i);
});
