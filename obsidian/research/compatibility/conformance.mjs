import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
const refs=rs=>rs.map(r=>({kind:r.kind,original:r.original??null,link:r.link,subpath:r.subpath,path:r.path}));
export function checkCompatibility(actual,oracle,{profile='strict-reference'}={}){
  if(!oracle.profiles[profile])throw Error('Unknown profile '+profile);
  const failures=[],diagnostics=[];let assertions=0;
  const equal=(a,b,label)=>{assertions++;if(!isDeepStrictEqual(a,b))failures.push({label,expected:b,actual:a});};
  equal(actual.status,'complete','suite.status');
  const rows=actual.results??[];
  equal(rows.length,oracle.cases.length,'suite.caseCount');
  equal(new Set(rows.map(c=>c.id)).size,rows.length,'unique case IDs');
  for(const test of oracle.cases){
    if(profile==='portable-core'&&test.quirk){diagnostics.push({id:test.id,reason:'observed quirk excluded by profile'});continue;}
    const row=rows.find(c=>c.id===test.id);
    assertions++;if(!row){failures.push({label:test.id,expected:'case present',actual:'missing'});continue;}
    equal(row.kind,test.kind,test.id+'.kind');
    equal(row.settle?.status,'stable-observed',test.id+'.settle');
    if(test.kind==='resolve'){
      equal(row.queries?.length,test.queries.length,test.id+'.queryCount');
      for(const q of test.queries){
        const got=row.queries?.find(x=>x.linkpath===q.linkpath&&x.sourcePath===q.sourcePath);
        assertions++;if(!got||!q.acceptedPaths.includes(got.path))failures.push({label:test.id+': '+q.linkpath+' @ '+q.sourcePath,expected:q.acceptedPaths,actual:got?.path??'missing query'});
        if(q.stability==='ambiguous-observed')diagnostics.push({id:test.id,query:q.linkpath,sourcePath:q.sourcePath,acceptedPaths:q.acceptedPaths,reason:'Repeated reference runs selected different tied candidates; deterministic order is not asserted.'});
      }
      for(const[p,expected]of Object.entries(test.references))equal(refs(row.references?.[p]??[]),expected,test.id+'.references:'+p);
    }else{
      equal(row.operationError??null,null,test.id+'.operationError');
      equal(Object.keys(row.after?.files??{}).sort(),Object.keys(test.files).sort(),test.id+'.fileSet');
      for(const[p,expected]of Object.entries(test.files)){
        const f=row.after?.files?.[p];equal(f?.text,expected.text,test.id+'.text:'+p);
        equal(refs(f?.references??[]),expected.references,test.id+'.references:'+p);
      }
      equal(row.after?.settings,test.settings,test.id+'.settings');
      equal(!!row.prompt,test.promptObserved,test.id+'.promptObserved');
    }
  }
  return {profile,passed:failures.length===0,assertions,failures,diagnostics};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const [actualPath,oraclePath=path.join(import.meta.dirname,'oracle.json'),profile='strict-reference']=process.argv.slice(2);
  if(!actualPath)throw Error('Usage: node conformance.mjs ACTUAL.json [ORACLE.json] [PROFILE]');
  const result=checkCompatibility(JSON.parse(fs.readFileSync(actualPath,'utf8')),JSON.parse(fs.readFileSync(oraclePath,'utf8')),{profile});
  console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
