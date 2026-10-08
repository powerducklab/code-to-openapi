import type { TsNode } from '../lang/treesitter/runtime.js';
import { findAll } from '../lang/treesitter/ast.js';

export interface SourceExcerpt {
  source: string;
  truncated: boolean;
  ranges: Array<{startLine:number;endLine:number}>;
}
/** Keep exact source ranges; gaps are explicit, never presented as adjacent source. */
export function sourceExcerpt(content:string,limit:number,handler:string|undefined,names:ReadonlySet<string>,root?:TsNode,tsSource?:any,ts?:any):SourceExcerpt {
  if(content.length<=limit)return {source:content,truncated:false,ranges:[{startLine:1,endLine:content.split('\n').length}]};
  const spans:Array<{start:number;end:number;priority:number}>=[];
  const offset=handler?content.indexOf(handler):-1;
  if(offset>=0)spans.push({start:offset,end:offset+handler!.length,priority:0});
  // A small header retains imports/namespace. Declaration ranges then use the remaining budget.
  spans.push({start:0,end:Math.min(1000,content.length),priority:1});
  if(root){
    const kinds=new Set(['class_definition','function_definition','class_declaration','interface_declaration','record_declaration','struct_declaration','enum_declaration','method_declaration','function_declaration','type_spec','function_item','struct_item','enum_item','trait_item','method_definition']);
    for(const node of findAll(root,n=>kinds.has(n.type))){
      const name=node.childForFieldName('name')?.text??node.namedChildren.find(n=>n.type==='name')?.text;
      if(name&&names.has(name)){
        // C# parsing may normalize source. Never use transformed AST offsets on original text.
        const start=content.indexOf(node.text);if(start>=0)spans.push({start,end:start+node.text.length,priority:2});
      }
    }
  }
  if(tsSource&&ts){
    const visit=(node:any)=>{
      if(node.name&&ts.isIdentifier(node.name)&&names.has(node.name.text)&&
        (ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)||ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)||ts.isVariableDeclaration(node)||ts.isMethodDeclaration(node))){
        const start=node.getStart(tsSource),end=node.getEnd();spans.push({start,end,priority:2});
      }
      ts.forEachChild(node,visit);
    };visit(tsSource);
  }
  spans.push({start:0,end:content.length,priority:3});
  spans.sort((a,b)=>a.priority-b.priority||(a.end-a.start)-(b.end-b.start)||a.start-b.start);
  const selected:Array<{start:number;end:number}>=[];
  const marker='\n/* … omitted source … */\n';
  let budget=limit;
  for(const span of spans){
    if(selected.some(s=>s.start<=span.start&&s.end>=span.end))continue;
    // Subtract overlapping ranges before spending budget.
    let fragments=[{start:span.start,end:span.end}];
    for(const prior of selected)fragments=fragments.flatMap(f=>{
      if(prior.end<=f.start||prior.start>=f.end)return [f];
      return [...(f.start<prior.start?[{start:f.start,end:prior.start}]:[]),...(f.end>prior.end?[{start:prior.end,end:f.end}]:[])];
    });
    for(const fragment of fragments){
      const available=budget-(selected.length?marker.length:0);if(available<=0)break;
      const end=Math.min(fragment.end,fragment.start+available);
      selected.push({start:fragment.start,end});budget-=end-fragment.start+(selected.length>1?marker.length:0);
    }
    if(budget<=marker.length)break;
  }
  selected.sort((a,b)=>a.start-b.start);
  return {source:selected.map(s=>content.slice(s.start,s.end)).join(marker),truncated:true,
    ranges:selected.map(s=>({startLine:content.slice(0,s.start).split('\n').length,endLine:content.slice(0,s.end).split('\n').length}))};
}
