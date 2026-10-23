import fs from 'node:fs';import path from 'node:path';
import {checkCompatibility} from './conformance.mjs';
const root=path.resolve(import.meta.dirname,'..');
const oracle=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'oracle.json'),'utf8'));
const baseline=JSON.parse(fs.readFileSync(path.join(root,'runtime-evidence','run09','observations.json'),'utf8'));
if(!checkCompatibility(baseline,oracle).passed)throw Error('Baseline does not conform');
const reordered=structuredClone(baseline);
for(const row of reordered.results.filter(c=>c.after))row.after.settings=Object.fromEntries(Object.entries(row.after.settings).reverse());
if(!checkCompatibility(reordered,oracle).passed)throw Error('Object property order must not change conformance');
const alternate=structuredClone(baseline);
const tied=oracle.cases.find(c=>c.id==='L06-tie-forward').queries[0];
alternate.results.find(c=>c.id==='L06-tie-forward').queries[0].path=tied.acceptedPaths.at(-1);
if(!checkCompatibility(alternate,oracle).passed)throw Error('Observed alternative tied candidate must be accepted');
const controls=[
  ['wrong-root-precedence',r=>{r.results.find(c=>c.id==='L02-root').queries[0].path='L02/A/NoteL02.md';}],
  ['lost-collision-target',r=>{r.results.find(c=>c.id==='R07-collision').after.files['R07/A/Source.md'].text='[[NoteR07]]\n';}],
  ['once-changes-preference',r=>{r.results.find(c=>c.id==='R05').after.settings.alwaysUpdateLinks=true;}],
  ['missing-case',r=>{r.results=r.results.filter(c=>c.id!=='R10-folder');}],
];
const results=[];
for(const[name,mutate]of controls){const actual=structuredClone(baseline);mutate(actual);const result=checkCompatibility(actual,oracle);if(result.passed)throw Error('Negative control was not rejected: '+name);results.push({name,rejected:true,failures:result.failures.length});}
console.log(JSON.stringify({baselinePassed:true,objectKeyOrderIndependent:true,alternateTiedCandidateAccepted:true,negativeControls:results},null,2));
