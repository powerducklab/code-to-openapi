/** Native HTTP evidence for the shared Express / Pages response analyzer. */
import express from 'express';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const app=express();
app.get('/empty',(_request,response)=>response.end());
app.get('/rejected',(_request,response)=>response.status(405).end());
app.get('/status',(_request,response)=>response.sendStatus(418));
const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
try{
 const rows=[];
 for(const path of ['/empty','/rejected','/status']){
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  rows.push({path,status:response.status,media:response.headers.get('content-type'),body:await response.text()});
 }
 assert.equal(rows[0].status,200);assert.equal(rows[0].body,'');
 assert.equal(rows[1].status,405);assert.equal(rows[1].body,'');
 assert.equal(rows[2].status,418);assert.match(rows[2].media,/^text\/plain/);
 writeFileSync(process.argv[2],JSON.stringify(rows,null,2));console.log('3 native HTTP termination probes passed');
}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
