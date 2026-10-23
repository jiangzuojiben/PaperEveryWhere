import test from 'node:test';import assert from 'node:assert/strict';
import {applyTemplate,formatDate,notePath,uniqueNotePath}from'../core/dates.mjs';
const now=new Date(2026,9,23,16,24,4);
test('daily formats preserve Moment literals and nested paths and templates use real time',()=>{assert.equal(formatDate(now,'YYYY/MM/[Day-]DD'),'2026/10/Day-23');assert.equal(notePath('Journal','2026/10/Day-23'),'Journal/2026/10/Day-23.md');assert.equal(applyTemplate('{{title}} {{date:YYYY/MM/DD}} {{time:HH:mm:ss}}',{now,title:'2026/10/Day-23'}),'2026/10/Day-23 2026/10/23 16:24:04');});
test('unique timestamp collisions advance by a minute without changing template wall clock',()=>{const result=uniqueNotePath(['20261023162404.md'],{now});assert.equal(result.path,'20261023162504.md');assert.equal(applyTemplate('{{title}} {{time:HH:mm:ss}}',{now,title:result.title}),'20261023162504 16:24:04');assert.throws(()=>uniqueNotePath(['collision.md'],{now,format:'[collision]'}));});
test('date naming rejects traversal and Windows-invalid names',()=>{assert.throws(()=>notePath('../private','today'));assert.throws(()=>notePath('Journal','16:24'));});
