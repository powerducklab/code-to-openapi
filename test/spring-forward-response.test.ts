import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('does not confuse an internal forward with a client redirect',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spring-forward-'));
 try{
 await writeFile(join(root,'ViewController.java'),`import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
@Controller
public class ViewController {
 @GetMapping("/forward") public String forward() { return "forward:/target"; }
 @GetMapping("/redirect") public String redirect() { return "redirect:/target"; }
}`);
 const result=await scanProject({root,frameworks:['spring']});
 const forward=result.project.operations.find(o=>o.path==='/forward')!;
 expect(forward.responses.map(r=>r.statusCode)).toEqual(['default']);
 expect(forward.gaps).toContain('response-unknown');
 expect(result.project.operations.find(o=>o.path==='/redirect')?.responses.map(r=>r.statusCode)).toEqual(['302']);
 }finally{await rm(root,{recursive:true,force:true});}
});
