import type {TsNode} from '../lang/treesitter/runtime.js';
import {findAll} from '../lang/treesitter/ast.js';
/** A method needs its class-level serializer/validator/injection declarations too. */
export function sourceFocus(root:TsNode,handler?:string):TsNode {
 if(!handler)return root;
 const kinds=new Set(['function_definition','decorated_definition','method_declaration','method_definition','function_declaration','function_item','lambda_expression','anonymous_function','arrow_function','func_literal']);
 const nodes=findAll(root,n=>kinds.has(n.type)&&n.text.startsWith(handler)).sort((a,b)=>a.text.length-b.text.length);
 let selected=nodes[0];if(!selected)return root;
 for(let parent=selected.parent;parent;parent=parent.parent)if(['class_definition','class_declaration','record_declaration','impl_item'].includes(parent.type)){selected=parent;break;}
 return selected;
}
export function sourceNames(root:TsNode):Set<string>{
 return new Set(findAll(root,n=>['identifier','type_identifier','field_identifier','name','package_identifier'].includes(n.type)).map(n=>n.text));
}
/** Include referenced same-file helpers before filtering import bindings. */
export function focusedSourceNames(root:TsNode,handler?:string):Set<string>{
 const focus=sourceFocus(root,handler),names=sourceNames(focus);
 if(focus===root)return names;
 const kinds=new Set(['function_definition','decorated_definition','function_declaration','function_item','class_definition','class_declaration','struct_item','enum_item','type_spec']);
 const declarations=findAll(root,n=>kinds.has(n.type));
 const seen=new Set<number>();
 let changed=true;
 while(changed){
  changed=false;
  for(const declaration of declarations){
   const name=declaration.childForFieldName('name')?.text;
   if(!name||!names.has(name)||seen.has(declaration.id))continue;
   seen.add(declaration.id);
   for(const referenced of sourceNames(declaration))if(!names.has(referenced)){names.add(referenced);changed=true;}
  }
 }
 return names;
}
