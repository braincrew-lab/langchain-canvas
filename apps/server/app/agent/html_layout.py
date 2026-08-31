"""Browser-computed geometry for editable PPTX; never captures a slide bitmap."""

LAYOUT_JS = r"""
() => {
  const items = [], unsupported = [];
  const context = document.createElement('canvas').getContext('2d');
  function box(r) { return {x:r.x,y:r.y,w:r.width,h:r.height}; }
  function visible(el) {
    const s=getComputedStyle(el);
    // Zero-height containers can still have visible positioned descendants.
    return s.display!=='none' && s.visibility!=='hidden' && Number(s.opacity)>0;
  }
  function paint(el, inheritedAlpha=1) {
    if (!visible(el)) return;
    const s=getComputedStyle(el), r=el.getBoundingClientRect();
    if (['SCRIPT','STYLE','HEAD'].includes(el.tagName)) return;
    const pptxId=el.closest('[data-pptx-shape-id]')?.getAttribute('data-pptx-shape-id');
    const base={...box(r),pptxId}, alpha=Number(s.opacity)*inheritedAlpha;
    if (s.filter!=='none' || s.clipPath!=='none') unsupported.push({reason:el.tagName+': filter/clip-path',...box(r)});
    if (el.tagName==='SVG' || el.tagName==='svg' || el.tagName==='CANVAS') {
      unsupported.push({reason:el.tagName+': use editable HTML shapes or an original image asset',...box(r)}); return;
    }
    if (s.transform.startsWith('matrix(')) {
      const m=s.transform.slice(7,-1).split(',').map(Number);
      if (Math.abs(m[1])>0.001 || Math.abs(m[2])>0.001) unsupported.push({reason:el.tagName+': rotated/skewed element',...box(r)});
    }
    for (const pseudo of ['::before','::after']) {
      const p=getComputedStyle(el,pseudo);
      if (p.content!=='none' && p.content!=='normal' && p.content!=='""') unsupported.push({reason:el.tagName+': pseudo-element content',...box(r)});
    }
    if (r.width>0 && r.height>0 && (s.backgroundColor!=='rgba(0, 0, 0, 0)' || s.backgroundImage!=='none')) {
      if (s.backgroundImage.startsWith('url(')) {
        items.push({...base,kind:'image',src:s.backgroundImage.slice(4,-1).replace(/^["']|["']$/g,''),fit:s.backgroundSize==='contain'?'contain':'cover',alpha});
      } else {
        items.push({...base,kind:'shape',fill:s.backgroundColor,gradient:s.backgroundImage,radius:parseFloat(s.borderTopLeftRadius)||0,alpha});
      }
    }
    const triangle=el.clientWidth===0 && el.clientHeight===0;
    const tip=[r.left+parseFloat(s.borderLeftWidth),r.top+parseFloat(s.borderTopWidth)];
    for (const [side,x1,y1,x2,y2] of [
      ['Top',r.left,r.top,r.right,r.top], ['Bottom',r.left,r.bottom,r.right,r.bottom],
      ['Left',r.left,r.top,r.left,r.bottom], ['Right',r.right,r.top,r.right,r.bottom]]) {
      const thickness=parseFloat(s['border'+side+'Width']);
      const color=s['border'+side+'Color'];
      if(thickness>0 && s['border'+side+'Style']!=='none' && color!=='rgba(0, 0, 0, 0)') {
        if(triangle) items.push({...base,kind:'polygon',points:[[x1,y1],[x2,y2],tip],fill:color,alpha});
        else items.push({kind:'line',pptxId,x:x1,y:y1,x2,y2,color,thickness,alpha});
      }
    }
    if (el.tagName==='IMG') {
      if (!el.complete || !el.naturalWidth) unsupported.push({reason:'image could not be loaded',...box(r)});
      else items.push({...base,kind:'image',src:el.currentSrc||el.src,fit:s.objectFit,alpha});
      return;
    }
    // Keep inline spans as separate runs so bold/color/font changes stay editable.
    // Range rectangles retain the browser's actual wrapping without guessing widths.
    const children=Array.from(el.childNodes).map((node,index)=>({node,index,z:node.nodeType===Node.ELEMENT_NODE?(parseInt(getComputedStyle(node).zIndex)||0):0})).sort((a,b)=>a.z-b.z||a.index-b.index);
    for (const {node:child} of children) {
      if (child.nodeType===Node.TEXT_NODE) {
        const str=child.textContent || '', range=document.createRange(); let line=null;
        context.font=`${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
        for(let i=0;i<str.length;i++) {
          range.setStart(child,i); range.setEnd(child,i+1);
          const cr=range.getBoundingClientRect();
          if(cr.width===0 || cr.height===0) continue;
          const ch=/\s/.test(str[i]) && s.whiteSpace==='normal' ? ' ' : str[i];
          const gm=context.measureText(ch);
          const glyph={text:ch,x:cr.x-gm.actualBoundingBoxLeft,y:cr.y+gm.fontBoundingBoxAscent-gm.actualBoundingBoxAscent,w:gm.actualBoundingBoxLeft+gm.actualBoundingBoxRight,h:gm.actualBoundingBoxAscent+gm.actualBoundingBoxDescent};
          if(line && Math.abs(line.y-cr.y)<1 && Math.abs(line.x+line.w-cr.x)<3) {
            line.text+=ch; line.w=cr.right-line.x;
            line.glyphs.push(glyph);
          } else {
            if(line && line.text.trim()) items.push(line);
            line={...box(cr),pptxId,kind:'text',blockKey:textKey(textOwner(el)),text:ch,glyphs:[glyph],font:s.fontFamily,size:parseFloat(s.fontSize),weight:s.fontWeight,italic:s.fontStyle==='italic',underline:s.textDecorationLine.includes('underline'),color:s.color,alpha};
          }
        }
        if(line && line.text.trim()) items.push(line);
      } else if(child.nodeType===Node.ELEMENT_NODE) paint(child,alpha);
    }
  }
  paint(document.body);
  // Object identity never dedupes, so key on reason plus box instead.
  const distinct=new Map(unsupported.map(u=>[JSON.stringify(u),u]));
  return {width:innerWidth,height:innerHeight,items,unsupported:[...distinct.values()]};
}
"""
