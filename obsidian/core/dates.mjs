import moment from 'moment';
import {normalizePath} from './vault.mjs';
export function formatDate(value,pattern='YYYY-MM-DD'){const date=moment(value);if(!date.isValid())throw Error('无效日期');return date.format(pattern);}
export function applyTemplate(text,{now=new Date(),title='',dateFormat='YYYY-MM-DD',timeFormat='HH:mm'}={}){
  return String(text).replace(/\{\{(date|time|title)(?::([^}]*))?\}\}/g,(raw,kind,pattern)=>kind==='title'?title:formatDate(now,pattern||(kind==='date'?dateFormat:timeFormat)));
}
export function notePath(folder,name){const raw=(folder?folder.replace(/\/$/,'')+'/':'')+name+'.md';const result=normalizePath(raw);if(!result||result!==raw||/[<>:"|?*\x00-\x1f]/.test(result))throw Error('日期格式包含无效文件名字符');return result;}
export function uniqueNotePath(paths,{folder='',format='YYYYMMDDHHmmss',now=new Date()}={}){
  const used=new Set(paths.map(p=>p.toLocaleLowerCase())),seen=new Set();
  for(let minute=0;minute<1440;minute++){
    const title=formatDate(moment(now).add(minute,'minute').toDate(),format),path=notePath(folder,title);
    if(!used.has(path.toLocaleLowerCase()))return{path,title};
    if(seen.has(path))throw Error('唯一笔记格式产生重名，请使用包含小时和分钟的格式');
    seen.add(path);
  }
  throw Error('唯一笔记名称仍有冲突，请修改格式');
}
