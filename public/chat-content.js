// Messages are untrusted. Render text and a small formatting vocabulary as DOM,
// never interpret HTML, and never turn a mention into executable markup.
const node=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
export function renderText(text,mentions=[],people=[]) {
  const fragment=document.createDocumentFragment();
  const names=people.filter(p=>mentions.includes(p.id)).map(p=>p.name).sort((a,b)=>b.length-a.length);
  function inline(value,parent){
    const tokens=/(`[^`\n]+`|\*\*[^*\n]+\*\*|https?:\/\/[^\s<>]+)/g;let end=0;
    function plain(part){let cursor=0;while(cursor<part.length){const at=part.indexOf('@',cursor);if(at<0){parent.append(document.createTextNode(part.slice(cursor)));break;}parent.append(document.createTextNode(part.slice(cursor,at)));const name=names.find(n=>part.slice(at+1,at+1+n.length)===n&&(!at||/\s/.test(part[at-1]))&&(!part[at+1+n.length]||/[\s.,!?，。！？:：;；]/u.test(part[at+1+n.length])));if(name){parent.append(node('span','message-mention','@'+name));cursor=at+1+name.length;}else{parent.append(document.createTextNode('@'));cursor=at+1;}}}
    for(const match of value.matchAll(tokens)){plain(value.slice(end,match.index));const token=match[0];if(token.startsWith('`'))parent.append(node('code','inline-code',token.slice(1,-1)));else if(token.startsWith('**'))parent.append(node('strong','',token.slice(2,-2)));else{const a=node('a','message-link',token);a.href=token;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);}end=match.index+token.length;}plain(value.slice(end));
  }
  function prose(block){
    const lines=block.split('\n'),cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s=>s.trim());
    const separator=line=>line?.includes('|')&&cells(line).every(cell=>/^:?-{3,}:?$/.test(cell));
    let plain=[];const flush=()=>{if(plain.length){inline(plain.join('\n'),fragment);plain=[];}};
    for(let i=0;i<lines.length;i++){
      if(lines[i].includes('|')&&separator(lines[i+1])&&cells(lines[i]).length===cells(lines[i+1]).length){
        flush();const wrap=node('div','message-table'),table=node('table'),head=node('thead'),header=node('tr'),body=node('tbody');
        for(const value of cells(lines[i])){const cell=node('th');cell.scope='col';inline(value,cell);header.append(cell);}head.append(header);i++;
        while(i+1<lines.length&&lines[i+1].trim()&&lines[i+1].includes('|')){const row=node('tr');for(const value of cells(lines[++i])){const cell=node('td');inline(value,cell);row.append(cell);}body.append(row);}
        table.append(head,body);wrap.append(table);fragment.append(wrap);
      }else if(/^\s*[-*] +\S/.test(lines[i])){
        flush();const list=node('ul','message-list-items');do{const item=node('li');inline(lines[i].replace(/^\s*[-*] +/,''),item);list.append(item);i++;}while(i<lines.length&&/^\s*[-*] +\S/.test(lines[i]));i--;fragment.append(list);
      }else plain.push(lines[i]);
    }
    flush();
  }
  const blocks=String(text).split(/(```[^\n]*\n[\s\S]*?```)/g);
  for(const block of blocks){if(!block)continue;if(block.startsWith('```')){const first=block.indexOf('\n'),pre=node('pre','message-code');pre.append(node('code','',block.slice(first+1,-3).replace(/\n$/,'')));fragment.append(pre);}else prose(block);}
  return fragment;
}
