import test from 'node:test';import assert from 'node:assert/strict';
import {restorePanes,remapPath,remapPanes,moveTab} from '../core/workspace.mjs';
test('restoring a layout preserves pins and view options while pruning missing files',()=>{assert.deepEqual(restorePanes([{tabs:['a.md','gone.md','@web:https://example.com'],active:'gone.md',pinned:['a.md','gone.md'],mode:'source'}],['a.md']),[{tabs:['a.md','@web:https://example.com'],active:'a.md',pinned:['a.md'],mode:'source'}]);});
test('folder rename maintains panes pins and local graph centers without prefix collisions',()=>{const result=remapPanes([{tabs:['A/x.md','AB/y.md','@localgraph:A/x.md'],active:'A/x.md',pinned:['A/x.md']}],'A','B');assert.deepEqual(result[0],{tabs:['B/x.md','AB/y.md','@localgraph:B/x.md'],active:'B/x.md',pinned:['B/x.md']});});
test('moving tabs retains pins, fixes the source selection and never duplicates a tab',()=>{const input=[{tabs:['a','b'],active:'a',pinned:['a']},{tabs:['a','c'],active:'c'}];const result=moveTab(input,0,'a',1,1);assert.deepEqual(result[0].tabs,['b']);assert.equal(result[0].active,'b');assert.deepEqual(result[1].tabs,['c','a']);assert.deepEqual(result[1].pinned,['a']);assert.deepEqual(input[0].tabs,['a','b']);});

test('renaming a hash filename updates its full tab, active item, pin and local graph',()=>{
  const original=[{tabs:['C# Basics.md','C.md','@localgraph:C# Basics.md'],active:'C# Basics.md',pinned:['C# Basics.md','@localgraph:C# Basics.md'],mode:'source'}];
  const before=structuredClone(original);
  assert.deepEqual(remapPanes(original,'C# Basics.md','C# Advanced.md'),[{
    tabs:['C# Advanced.md','C.md','@localgraph:C# Advanced.md'],active:'C# Advanced.md',
    pinned:['C# Advanced.md','@localgraph:C# Advanced.md'],mode:'source',
  }]);
  assert.deepEqual(original,before);
});

test('hash directories and child filenames remap without similarly prefixed directory collisions',()=>{
  const original=[{tabs:['Projects#2026/C# Basics.md','Projects#2026-old/C# Basics.md','@localgraph:Projects#2026/计划#一.md'],active:'@localgraph:Projects#2026/计划#一.md',pinned:['Projects#2026/C# Basics.md']}];
  assert.deepEqual(remapPanes(original,'Projects#2026','Archive#2026'),[{
    tabs:['Archive#2026/C# Basics.md','Projects#2026-old/C# Basics.md','@localgraph:Archive#2026/计划#一.md'],
    active:'@localgraph:Archive#2026/计划#一.md',pinned:['Archive#2026/C# Basics.md'],
  }]);
});

test('pane paths never interpret a different hash filename as a fragment of the renamed file',()=>{
  const original=[{tabs:['A.md','A.md#draft.md','@localgraph:A.md#draft.md'],active:'A.md#draft.md',pinned:['A.md#draft.md']}];
  assert.deepEqual(remapPanes(original,'A.md','B.md'),[{
    tabs:['B.md','A.md#draft.md','@localgraph:A.md#draft.md'],active:'A.md#draft.md',pinned:['A.md#draft.md'],
  }]);
});

test('optional reference fragments follow the complete hash filename and remain byte-for-byte intact',()=>{
  assert.equal(remapPath('C# Basics.md#标题#子标题','C# Basics.md','C# Advanced.md',{allowFragment:true}),'C# Advanced.md#标题#子标题');
  assert.equal(remapPath('@localgraph:C# Basics.md#^block-1','C# Basics.md','C# Advanced.md',{allowFragment:true}),'@localgraph:C# Advanced.md#^block-1');
  assert.equal(remapPath('C# Basics.md#draft.md','C# Basics.md','new.md'),'C# Basics.md#draft.md');
  assert.equal(remapPath('C# Basics.md#draft.md','C# Basics.md','new.md',{allowFragment:false}),'C# Basics.md#draft.md');
  assert.equal(remapPath('C# Basics.md.old#标题','C# Basics.md','new.md'),'C# Basics.md.old#标题');
  assert.equal(remapPath(null,'a','b'),null);
});

test('merging into an open target deduplicates tabs and pins while retaining mapped active and options',()=>{
  const original=[{
    tabs:['source.md','middle.md','target.md','@localgraph:source.md','@localgraph:target.md'],
    active:'source.md',pinned:['source.md','target.md','@localgraph:target.md'],mode:'reading',width:420,
  },{tabs:['target.md','source.md','other.md'],active:'other.md',pinned:['source.md']}];
  const before=structuredClone(original);
  assert.deepEqual(remapPanes(original,'source.md','target.md'),[{
    tabs:['target.md','middle.md','@localgraph:target.md'],active:'target.md',
    pinned:['target.md','@localgraph:target.md'],mode:'reading',width:420,
  },{tabs:['target.md','other.md'],active:'other.md',pinned:['target.md']}]);
  assert.deepEqual(original,before);
});

test('folder merge collisions retain one target in each pane and a union of valid pins',()=>{
  const original=[{tabs:['Destination/x.md','Source/x.md','Source/y.md','Destination/y.md'],active:'Destination/x.md',pinned:['Source/x.md','Destination/x.md','Destination/y.md','missing.md']},{tabs:[],active:null,pinned:[]}];
  assert.deepEqual(remapPanes(original,'Source','Destination'),[{
    tabs:['Destination/x.md','Destination/y.md'],active:'Destination/x.md',pinned:['Destination/x.md','Destination/y.md'],
  },{tabs:[],active:null,pinned:[]}]);
});
