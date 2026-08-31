"""Semantic DOM text boxes shared by export and slide editing tools."""

TEXT_OWNER_JS = r"""
  function textOwner(el) {
    const explicit=el.closest('[data-text-block="true"]');
    if(explicit) return explicit;
    for(let node=el;node && node!==document.body;node=node.parentElement) {
      if(/^(P|H[1-6]|LI|TD|TH|PRE|BLOCKQUOTE)$/.test(node.tagName))return node;
      const s=getComputedStyle(node);
      if(node.hasAttribute('data-pptx-shape-id') ||
        (node.hasAttribute('data-node-id') && ['absolute','fixed'].includes(s.position)))return node;
      if(!['inline','contents'].includes(s.display) &&
        Array.from(node.childNodes).some(n=>n.nodeType===Node.TEXT_NODE && n.textContent.trim()))return node;
    }
    return el;
  }
  function textKey(el) {return 'text-'+Array.from(document.querySelectorAll('*')).indexOf(el);}
"""

SEMANTIC_LAYOUT_JS = r"""
() => {
  const owners=new Set(), properties=['font-family','font-size','font-weight','font-style','color',
    'line-height','letter-spacing','text-align','text-decoration','white-space','background-color',
    'padding-top','padding-right','padding-bottom','padding-left','box-sizing','position','transform',
    'left','top','width','height','border-radius','border-color','background-image','opacity','object-fit'];
  const styles=el=>{const s=getComputedStyle(el);return Object.fromEntries(properties.map(k=>[k,s.getPropertyValue(k)]));};
  const visible=el=>{for(let n=el;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}return true;};
  const rangeBox=node=>{const r=document.createRange();r.selectNodeContents(node);return r.getBoundingClientRect();};
  // Empty placeholders are still editable and must clear their native PPTX shape.
  for(const el of document.querySelectorAll('[data-text-block="true"],p[data-node-id],h1[data-node-id],h2[data-node-id],h3[data-node-id],li[data-node-id],td[data-node-id],th[data-node-id]')) {
    if(visible(el) && textOwner(el)===el)owners.add(el);
  }
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node;node=walker.nextNode()) {
    if(node.textContent.trim() && !/^(STYLE|SCRIPT)$/.test(node.parentElement.tagName) && visible(node.parentElement))owners.add(textOwner(node.parentElement));
  }
  function inkBounds(el) {
    const keys=new Set(Array.from(owners).filter(owner=>el===owner||el.contains(owner)).map(textKey));
    const ink=painted.items.filter(item=>item.kind==='text'&&keys.has(item.blockKey))
      .flatMap(item=>item.glyphs||[]).filter(g=>g.w>0&&g.h>0);
    if(ink.length)return {x:Math.min(...ink.map(g=>g.x)),y:Math.min(...ink.map(g=>g.y)),
      right:Math.max(...ink.map(g=>g.x+g.w)),bottom:Math.max(...ink.map(g=>g.y+g.h))};
    const boxes=[];const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    for(let n=walk.nextNode();n;n=walk.nextNode()) {
      if(!n.textContent.trim() || !visible(n.parentElement))continue;
      const r=rangeBox(n);if(r.width&&r.height)boxes.push(r);
    }
    return boxes.length?{x:Math.min(...boxes.map(r=>r.x)),y:Math.min(...boxes.map(r=>r.y)),
      right:Math.max(...boxes.map(r=>r.right)),bottom:Math.max(...boxes.map(r=>r.bottom))}:null;
  }
  function describe(el) {
    const r=el.getBoundingClientRect(),s=getComputedStyle(el),b=inkBounds(el),
      px=n=>parseFloat(s.getPropertyValue(n))||0;
    return {id:el.getAttribute('data-node-id'),key:textKey(el),tag:el.tagName.toLowerCase(),
      pptxId:el.closest('[data-pptx-shape-id]')?.getAttribute('data-pptx-shape-id')||null,pptxRoot:el.hasAttribute('data-pptx-shape-id'),x:r.x,y:r.y,w:r.width,h:r.height,text:el.textContent||'',style:styles(el),visible:visible(el),
      transformedAncestor:(()=>{for(let p=el.parentElement;p;p=p.parentElement)if(getComputedStyle(p).transform!=='none'||!['1','normal'].includes(getComputedStyle(p).zoom))return true;return false;})(),
      textBlock:owners.has(el),textBounds:b,advanceBounds:(()=>{const a=rangeBox(el);return {x:a.x,y:a.y,right:a.right,bottom:a.bottom};})(),
      overflowX:b?Math.max(0,r.left+px('padding-left')-b.x,b.right-(r.right-px('padding-right'))):0,
      overflowY:b?Math.max(0,r.top+px('padding-top')-b.y,b.bottom-(r.bottom-px('padding-bottom'))):0};
  }
  function runStyle(el) {
    const s=getComputedStyle(el);
    let alpha=1;for(let n=el;n;n=n.parentElement)alpha*=Number(getComputedStyle(n).opacity);
    return {font:s.fontFamily,size:parseFloat(s.fontSize),weight:s.fontWeight,
      color:s.color,italic:s.fontStyle==='italic',underline:s.textDecorationLine.includes('underline'),
      letterSpacing:parseFloat(s.letterSpacing)||0,alpha};
  }
  function textBlock(el) {
    const s=getComputedStyle(el),base=describe(el), paragraphs=[];
    const newParagraph=node=>({runs:[],align:getComputedStyle(node).textAlign,
      lineHeight:parseFloat(getComputedStyle(node).lineHeight)||parseFloat(getComputedStyle(node).fontSize)*1.2,
      spaceBefore:0,spaceAfter:0});
    let paragraph=newParagraph(el);paragraphs.push(paragraph);
    function collect(node) {
      if(node.nodeType===Node.TEXT_NODE) {
        const owner=textOwner(node.parentElement);if(owner!==el)return;
        const b=rangeBox(node);if(!b.width||!b.height)return;
        const white=getComputedStyle(node.parentElement).whiteSpace;
        const text=['normal','nowrap'].includes(white)?node.textContent.replace(/\s+/g,' '):node.textContent;
        paragraph.runs.push({text,...runStyle(node.parentElement)});return;
      }
      if(node.nodeType!==Node.ELEMENT_NODE||!visible(node)||/^(STYLE|SCRIPT)$/.test(node.tagName))return;
      if(node.tagName==='BR'){paragraph.runs.push({break:true});return;}
      const isParagraph=node!==el && /^(P|LI)$/.test(node.tagName);
      if(isParagraph && paragraph.runs.length){paragraph=newParagraph(node);paragraphs.push(paragraph);}
      for(const child of node.childNodes)collect(child);
      if(isParagraph){paragraph=newParagraph(el);paragraphs.push(paragraph);}
    }
    for(const child of el.childNodes)collect(child);
    return {...base,kind:'textBlock',...runStyle(el),whiteSpace:s.whiteSpace,
      padding:['Top','Right','Bottom','Left'].map(side=>parseFloat(s['padding'+side])||0),
      paragraphs:paragraphs.filter(p=>p.runs.some(r=>r.text?.trim()))};
  }
  const blocks=Array.from(owners).map(textBlock), warnings=[];
  const fontContext=document.createElement('canvas').getContext('2d');
  const generic=new Set(['serif','sans-serif','monospace','cursive','fantasy','system-ui','ui-sans-serif','ui-serif','ui-monospace','-apple-system','blinkmacsystemfont']);
  for(const font of new Set(blocks.flatMap(b=>b.paragraphs.flatMap(p=>p.runs.filter(r=>r.font).map(r=>r.font.split(',')[0].replace(/["']/g,'').trim()))))) {
    if(generic.has(font.toLowerCase()))continue;
    const missing=['monospace','serif'].every(fallback=>{
      fontContext.font='72px '+fallback;const base=fontContext.measureText('mmmmWWWW012345').width;
      fontContext.font='72px '+JSON.stringify(font)+','+fallback;
      return Math.abs(fontContext.measureText('mmmmWWWW012345').width-base)<0.01;
    });
    if(missing)warnings.push({code:'font_substitution',font,message:'Requested font is unavailable in the renderer; fallback font metrics were used.'});
  }
  for(let i=0;i<blocks.length;i++)for(let j=i+1;j<blocks.length;j++) {
    const a=blocks[i],b=blocks[j],r=a.textBounds,s=b.textBounds;if(!r||!s)continue;
    const overlapX=Math.min(r.right,s.right)-Math.max(r.x,s.x),overlapY=Math.min(r.bottom,s.bottom)-Math.max(r.y,s.y);
    if(overlapX>4&&overlapY>4)warnings.push({code:'text_overlap',ids:[a.id||a.key,b.id||b.key],message:'Text ink overlaps another text block; review intentional overlays.'});
  }
  return {elements:Array.from(new Set([...document.querySelectorAll('[data-node-id]'),...owners])).map(describe),
    textBlocks:blocks,warnings};
}
"""
