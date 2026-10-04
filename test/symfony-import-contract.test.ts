import {expect,it} from 'vitest';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('loads YAML import prefixes, repeated attributes, inherited verbs and collapses unrestricted methods to GET',async()=>{
 const root=await mkdtemp(join(tmpdir(),'symfony-import-'));
 try{
 await mkdir(join(root,'config'));await mkdir(join(root,'src'));await mkdir(join(root,'src/Controller'));
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{'symfony/framework-bundle':'^8'}}));
 await writeFile(join(root,'config/routes.yaml'),`controllers:\n  resource: ../src/Controller/\n  type: attribute\n  prefix: /{_locale}\nhealth:\n  path: /health\n  methods:\n    - GET\n  controller: App\\Controller\\Blog::health\n`);
 await writeFile(join(root,'src/Controller/Blog.php'),`<?php
 namespace App\\Controller;
 use Symfony\\Component\\Routing\\Attribute\\Route;
 #[Route('/blog',methods:['GET'])] class Blog {
 #[Route('/')] #[Route('/feed')] public function index(){return new Response('ok');}
 public function health(){return new Response('ok');}
 }
 class Login {#[Route('/login')] public function login(){return new Response('ok');}}
 `);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);const doc=converted.document as any;
 expect(Object.keys(doc.paths['/{_locale}/blog/'])).toContain('get');expect(doc.paths['/{_locale}/blog/'].post).toBeUndefined();
 expect(doc.paths['/{_locale}/blog/feed'].get).toBeDefined();
 expect(doc.paths['/{_locale}/login'].get).toBeDefined();expect(doc.paths['/{_locale}/login'].patch).toBeUndefined();expect(doc.paths['/{_locale}/login'].trace).toBeUndefined();
 expect(doc.paths['/health'].get).toBeDefined();expect(doc.paths['/health'].post).toBeUndefined();
 expect(doc.paths['/{_locale}/blog/'].get.parameters).toContainEqual(expect.objectContaining({name:'_locale',in:'path',required:true}));
 }finally{await rm(root,{recursive:true,force:true});}
});
