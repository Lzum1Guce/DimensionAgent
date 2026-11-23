export const stickerUrl=id=>`/api/dimension/stickers/${encodeURIComponent(id)}/content`;
export function renderStickers(element,text,renderText) {
  element.replaceChildren();let cursor=0;
  const append=value=>{if(!value)return;const span=document.createElement('span');if(renderText)span.innerHTML=renderText(value);else span.textContent=value;element.append(span);};
  for(const match of String(text).matchAll(/\[sticker:([^\]\r\n]{1,80})\]/g)) {
    append(text.slice(cursor,match.index));const img=document.createElement('img');img.src=stickerUrl(match[1]);img.alt='[表情包]';img.className='chat-sticker';img.loading='lazy';
    img.onerror=()=>{const fallback=document.createElement('span');fallback.textContent='[表情暂不可用]';img.replaceWith(fallback);};element.append(img);cursor=match.index+match[0].length;
  }append(text.slice(cursor));
}

// 面板样式位于 panels-p1.css；若 index.html 尚未引入则按需补挂一次。
const ensurePanelStyles=()=>{
  if(document.querySelector('link[href*="panels-p1.css"]'))return;
  const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./panels-p1.css',import.meta.url).pathname;document.head.append(link);
};
const toast=(message,level='info')=>{try{window.__dimensionToast?.(message,{level});}catch{}};
const confirmRemove=async name=>{
  const message=`把「${name}」移出表情库？\n表情库由所有伙伴和茶会共享，移除后大家都无法再使用它，聊天记录里引用它的位置会显示为「表情暂不可用」。`;
  if(window.__dimensionConfirm)return Boolean(await window.__dimensionConfirm({title:'移出共享表情库',message,confirmLabel:'移出表情库',danger:true}));
  return window.confirm(message);
};

export function openStickerPicker(onPick) {
  ensurePanelStyles();
  const dialog=document.createElement('dialog');dialog.className='sticker-dialog sticker-p1';dialog.setAttribute('aria-label','公共表情库');
  dialog.innerHTML='<header class="sticker-p1-head"><strong>公共表情库</strong><button type="button" class="close">关闭</button></header>'
    +'<p class="sticker-p1-sub">所有伙伴和茶会共用，GIF 会保留动图。</p>'
    +'<div class="sticker-p1-toolbar"><button type="button" class="sticker-add">＋ 添加表情</button>'
    +'<input type="file" class="sticker-file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden tabindex="-1" aria-hidden="true">'
    +'<span class="sticker-p1-status" role="status" aria-live="polite"></span></div>'
    +'<div class="sticker-grid" aria-busy="true"></div>';
  document.body.append(dialog);
  const grid=dialog.querySelector('.sticker-grid'),status=dialog.querySelector('.sticker-p1-status'),input=dialog.querySelector('.sticker-file'),addBtn=dialog.querySelector('.sticker-add');
  dialog.querySelector('.close').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();dialog.showModal();
  const say=(text,level)=>{status.textContent=text;status.dataset.level=level||'';};
  const placeholder=(className,text)=>{const p=document.createElement('p');p.className=className;p.textContent=text;return p;};
  const emptyState=()=>{
    const box=document.createElement('div');box.className='sticker-empty';
    const icon=document.createElement('span');icon.className='sticker-empty-icon';icon.textContent='✦';icon.setAttribute('aria-hidden','true');
    const title=document.createElement('strong');title.textContent='表情库还空空如也';
    const tip=document.createElement('span');tip.textContent='点「添加表情」放入你喜欢的图，GIF 会保留动图；单张最大 8 MB，支持多选。';
    box.append(icon,title,tip);return box;
  };
  let loadVersion=0;
  const load=async()=>{
    const ticket=++loadVersion;grid.setAttribute('aria-busy','true');
    if(!grid.querySelector('.sticker-item'))grid.replaceChildren(placeholder('sticker-loading','✦ 正在取出表情…'));
    const r=await fetch('/api/dimension/stickers');if(!r.ok)throw new Error('表情库加载失败');const {stickers=[]}=await r.json();
    if(ticket!==loadVersion||!dialog.isConnected)return;
    grid.setAttribute('aria-busy','false');
    if(!stickers.length){grid.replaceChildren(emptyState());return;}
    grid.replaceChildren(...stickers.map(row=>{
      const name=row.name||'表情';
      const item=document.createElement('div'),button=document.createElement('button'),image=document.createElement('img'),label=document.createElement('span'),remove=document.createElement('button');
      item.className='sticker-item';button.type='button';button.className='sticker-pick';button.title=`发送「${name}」`;
      image.src=stickerUrl(row.id);image.alt=name;image.loading='lazy';label.textContent=name;button.append(image,label);
      button.onclick=()=>{dialog.close();onPick(row);};
      remove.type='button';remove.className='sticker-remove';remove.textContent='×';
      remove.setAttribute('aria-label',`从共享表情库移除「${name}」`);remove.title='移出表情库（所有伙伴共享）';
      remove.onclick=async event=>{
        event.stopPropagation();
        if(!await confirmRemove(name))return;
        remove.disabled=true;
        try{const r=await fetch(`/api/dimension/stickers/${encodeURIComponent(row.id)}`,{method:'DELETE'});if(!r.ok)throw new Error('删除失败，请稍后重试');say(`已移出「${name}」`,'success');await load();}
        catch(e){say(e.message,'error');toast(e.message,'error');remove.disabled=false;}
      };
      item.append(button,remove);return item;
    }));
  };
  const reportLoadError=e=>{grid.setAttribute('aria-busy','false');grid.replaceChildren(placeholder('sticker-loading',e.message||'表情库加载失败'));say(e.message||'表情库加载失败','error');toast(e.message||'表情库加载失败','error');};
  addBtn.onclick=()=>{if(!addBtn.disabled)input.click();};
  input.onchange=async()=>{
    const files=[...input.files];if(!files.length)return;
    addBtn.disabled=true;addBtn.classList.add('is-busy');let done=0;
    try{
      for(const file of files){
        if(file.size>8*1024*1024)throw new Error(`「${file.name}」超过 8 MB，未添加`);
        say(`正在上传 ${done+1}/${files.length}…`);
        const r=await fetch(`/api/dimension/stickers?name=${encodeURIComponent(file.name.replace(/\.[^.]+$/,''))}`,{method:'POST',headers:{'content-type':file.type},body:file});
        const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'上传失败');done++;
      }
      say(`✦ 已添加 ${done} 张表情`,'success');
    }catch(e){say(done?`已添加 ${done} 张；${e.message}`:e.message,'error');toast(e.message,'error');}
    finally{addBtn.disabled=false;addBtn.classList.remove('is-busy');input.value='';if(done)await load().catch(reportLoadError);}
  };
  void load().catch(reportLoadError);
}
