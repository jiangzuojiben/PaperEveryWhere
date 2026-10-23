/** One shared text contract prevents an unread attachment from becoming a blank editor. */
export const textExtensions = ['md','canvas','base','json','txt','css','csv','yaml','yml','js','jsx','ts','tsx','xml','html','htm'];
export const isTextPath = path => textExtensions.includes(String(path||'').split('.').at(-1).toLowerCase());
