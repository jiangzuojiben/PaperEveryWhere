// Parse inert reference syntax; never evaluate/import the ReadPaper bundle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const [source, output, parserPath] = process.argv.slice(2);
if (!source || !output || !parserPath || fs.existsSync(output)) throw Error('Supply SOURCE, absent OUTPUT and Babel parser path');
const require = createRequire(import.meta.url);
const {parse} = require(path.resolve(parserPath));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const selected = new Set(['getPaperVersions', 'changeCurrentPDF', 'getHandwrite', 'deleteHandwrite',
  'getPdfStatusInfo', 'getOwnerPaperNoteBaseInfo', 'getPaperNoteBaseInfoById',
  'postSaveAnnotation', 'renderHandwrite', 'createPathList', 'getIpadUnit', 'ToolType', 'DrawShapeType',
  'IDEAAnnotateType', 'IPAD_PDF_100', 'I2e', 'C2e']);
const report = {format:'paperdesk-readpaper-write-research-v1', sources:[], slices:[],
  limitations:['Static syntax only; no source code executed.',
    'Extracts omit imports/initialization; unresolved dependencies remain unknown.',
    'The drawing renderer does not establish a supported handwriting write endpoint.']};
fs.mkdirSync(path.join(output,'focused-sample'), {recursive:true});
for (const name of ['useVipPayConfig-f9cb04db.js','index-64368679.js']) {
  const bytes = fs.readFileSync(path.join(source,name));
  const text = bytes.toString('utf8');
  const ast = parse(text,{sourceType:'module'});
  const chunks=[];
  report.sources.push({file:name,bytes:bytes.length,sha256:sha(bytes)});
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (['FunctionDeclaration','VariableDeclarator'].includes(node.type) && node.id?.type==='Identifier') {
      const symbol=node.id.name;
      const raw=text.slice(node.start,node.end);
      const upload=(symbol==='ui' && raw.includes('uploadPdfDoc')) ||
        (symbol==='dn' && raw.includes('GetPdfNeedUploadPdf')) ||
        (symbol==='hr' && raw.includes('GetUploadToken')) ||
        (symbol==='Vi' && raw.includes('resolveConflict'));
      if (selected.has(symbol) || upload) {
        const prefix=node.type==='VariableDeclarator' ? `${parent.kind} ` : '';
        chunks.push(prefix+raw+(prefix?';':''));
        report.slices.push({file:name,symbol,start_utf16:node.start,end_utf16:node.end,
          start_byte:Buffer.byteLength(text.slice(0,node.start)),end_byte:Buffer.byteLength(text.slice(0,node.end)),
          slice_sha256:sha(raw),wrapper:prefix?`${prefix}<original-declarator>;`:'<original-function>'});
      }
    }
    for (const [key,value] of Object.entries(node)) {
      if (['loc','comments','tokens','extra'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child=>visit(child,node));
      else if (value && typeof value==='object') visit(value,node);
    }
  }
  visit(ast.program,null);
  fs.writeFileSync(path.join(output,'focused-sample',name),chunks.join('\n'));
}
fs.writeFileSync(path.join(output,'provenance.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({sources:report.sources.length,slices:report.slices.length,
  bytes:fs.readdirSync(path.join(output,'focused-sample')).reduce((n,f)=>n+fs.statSync(path.join(output,'focused-sample',f)).size,0)}));
