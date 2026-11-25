export interface CatalogProduct {
  id: string;
  name: string;
  suggestedPrice: string | null;
  images: { id: string }[];
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const perPage = 9;

export function catalogHtml(products: CatalogProduct[], company: string, origin: string, logoVersion?: number | null) {
  const totalPages = Math.ceil(products.length / perPage);
  const pages = Array.from({ length: totalPages }, (_, index) => {
    const cards = products.slice(index * perPage, (index + 1) * perPage).map((product) => {
      const photo = product.images[0];
      const src = photo ? `${origin}/api/products/${encodeURIComponent(product.id)}/images/${encodeURIComponent(photo.id)}/file` : '';
      const price = product.suggestedPrice === null ? NaN : Number(product.suggestedPrice);
      return `<article><div class="photo"><span>Sem foto</span>${photo ? `<img src="${escape(src)}" alt="" onerror="this.remove()">` : ''}</div><h2>${escape(product.name)}</h2><div class="price">${Number.isFinite(price) ? escape(currency.format(price)) : 'Consulte o preço'}</div></article>`;
    }).join('');
    return `<section class="sheet"><header><div><div class="eyebrow">${escape(company)}</div><h1>Catálogo de produtos</h1></div>${logoVersion ? `<img class="logo" src="${escape(`${origin}/api/branding/logo?v=${logoVersion}`)}" alt="" onerror="this.remove()">` : ''}</header><main>${cards}</main><footer><span>${escape(company)}</span><span>${index + 1} / ${totalPages}</span></footer></section>`;
  }).join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Catálogo de produtos - ${escape(company)}</title><style>
    @page{size:A4;margin:10mm} *{box-sizing:border-box} body{margin:0;background:#e8eef3;color:#142436;font:14px system-ui,sans-serif}
    .toolbar{position:sticky;top:0;z-index:1;background:#fff;padding:12px;text-align:center} button{cursor:pointer;border:0;border-radius:8px;background:#076b60;color:#fff;padding:10px 18px;font:600 14px system-ui}
    .sheet{width:190mm;margin:12px auto;background:#fff;padding:0;break-after:page} .sheet:last-child{break-after:auto}
    header{min-height:26mm;padding:5mm 7mm;display:flex;align-items:center;justify-content:space-between;gap:5mm;background:#103348;color:white;border-radius:4mm;border-left:3mm solid #16b5a1}
    .eyebrow{font-size:10pt;font-weight:700;letter-spacing:.07em;overflow-wrap:anywhere} h1{font-size:25pt;line-height:1.1;margin:1mm 0 0} .logo{max-width:32mm;max-height:17mm;object-fit:contain;background:white;border-radius:2mm;padding:1mm}
    main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4mm;margin:5mm 0}
    article{height:72mm;display:flex;flex-direction:column;gap:2mm;padding:3mm;border:1px solid #d8e3e7;border-radius:4mm;overflow:hidden;break-inside:avoid}
    .photo{height:38mm;flex:none;display:grid;place-items:center;position:relative;background:#f2f6f8;border-radius:2mm;color:#536879;font-size:9pt}
    .photo img{position:absolute;inset:0;width:100%;height:100%;padding:1.5mm;object-fit:contain;background:#fff}
    h2{margin:0;font-size:11pt;line-height:1.22;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
    .price{margin-top:auto;align-self:flex-start;padding:1.1mm 2.5mm;border-radius:2mm;background:#d9f6ef;color:#07574d;font-size:15pt;font-weight:800;line-height:1.15}
    footer{display:flex;justify-content:space-between;border-top:1px solid #d8e3e7;padding:2mm 0;color:#536879;font-size:9pt}
    @media print{body{background:white;print-color-adjust:exact;-webkit-print-color-adjust:exact}.toolbar{display:none}.sheet{width:auto;margin:0}}
    @media screen and (max-width:760px){.sheet{width:calc(100% - 16px)}main{grid-template-columns:repeat(2,minmax(0,1fr))}}
  
    #loading{position:fixed;inset:0;z-index:50;display:grid;place-items:center;background:#e8eef3;font:14px system-ui,sans-serif;color:#142436}
    #loading .box{display:grid;gap:10px;justify-items:center;width:min(86vw,360px);padding:26px 22px;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(16,51,72,.16);text-align:center}
    #loading strong{font-size:16px} #loading span{color:#536879}
    #loading .spin{width:38px;height:38px;border-radius:50%;border:4px solid #d9f6ef;border-top-color:#076b60;animation:dhspin .9s linear infinite}
    #loading .bar{width:100%;height:8px;border-radius:99px;background:#e1ebef;overflow:hidden} #loading .bar i{display:block;height:100%;width:0;background:#076b60;border-radius:99px;transition:width .15s}
    @keyframes dhspin{to{transform:rotate(360deg)}}
    body.loading .toolbar,body.loading .sheet{visibility:hidden}
    @media print{#loading{display:none}}
  </style></head><body class="loading"><div class="toolbar"><button type="button" onclick="window.print()">Imprimir / Salvar como PDF</button></div>${pages}<div id="loading" role="status" aria-live="polite"><div class="box"><div class="spin" aria-hidden="true"></div><strong>Carregando o catálogo</strong><span id="lmsg">Preparando as imagens…</span><div class="bar"><i id="lbar"></i></div></div></div><script>(function(){
var imgs=[].slice.call(document.querySelectorAll('img')),total=imgs.length,done=0,finished=false,msg=document.getElementById('lmsg'),bar=document.getElementById('lbar');
function show(){if(finished)return;finished=true;document.body.classList.remove('loading');var l=document.getElementById('loading');if(l)l.remove();}
function tick(){done++;var pct=total?Math.round(done/total*100):100;msg.textContent=done+' de '+total+' imagens ('+pct+'%)';bar.style.width=pct+'%';if(done>=total)setTimeout(show,150);}
if(!total){show();return;}
msg.textContent='0 de '+total+' imagens (0%)';
imgs.forEach(function(img){var ok=false;function once(){if(ok)return;ok=true;tick();}
img.addEventListener('load',once);img.addEventListener('error',once);if(img.complete)once();});
setTimeout(show,90000);
})();</script></body></html>`;
}

/** Tela de espera mostrada na janela do catálogo enquanto os produtos são buscados (as imagens têm a própria tela dentro do catálogo). */
export const catalogLoadingHtml = () => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Carregando o catálogo…</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e8eef3;font:14px system-ui,sans-serif;color:#142436}.box{display:grid;gap:10px;justify-items:center;width:min(86vw,360px);padding:26px 22px;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(16,51,72,.16);text-align:center}.spin{width:38px;height:38px;border-radius:50%;border:4px solid #d9f6ef;border-top-color:#076b60;animation:s .9s linear infinite}@keyframes s{to{transform:rotate(360deg)}}span{color:#536879}</style></head><body><div class="box"><div class="spin" aria-hidden="true"></div><strong>Carregando o catálogo</strong><span id="msg">Buscando os produtos…</span></div></body></html>`;
