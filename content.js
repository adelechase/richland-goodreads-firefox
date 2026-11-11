const API = typeof browser !== "undefined" ? browser : chrome;
const seen = new WeakSet();

function clean(s){ return (s||"").replace(/\s+/g," ").trim(); }
function isbnFromPage(){
  const body = document.body.innerText;
  const m = body.match(/ISBN(?:13)?\s*[:\n]?\s*(97[89][\d\s-]{10,16}|[\dX][\dX\s-]{8,15})/i);
  return m ? m[1].replace(/[^0-9X]/gi,"") : "";
}
function authorFromBookPage(){
  return clean(document.querySelector('.ContributorLink__name, [class*="ContributorLink"] span, a[href*="/author/show/"]')?.textContent);
}
function titleFromBookPage(){
  return clean(document.querySelector('h1[data-testid="bookTitle"], h1.Text__title1, main h1, h1')?.textContent);
}
function plural(n, one, many=one+"s"){ return `${n} ${n===1?one:many}`; }
function formatLine(f){
  if (f.digital) {
    const bits=[];
    if (f.always) bits.push("Always available");
    else if (Number.isFinite(f.available) && Number.isFinite(f.total)) bits.push(`${f.available} of ${f.total} available`);
    else if (f.statusText) bits.push(f.statusText);
    if (Number.isFinite(f.holds)) bits.push(plural(f.holds, "hold"));
    return bits.join(" · ") || "Found in collection";
  }
  const availability = f.available == null || f.total == null ? "availability not shown" : `${f.available} of ${f.total} available`;
  return `${availability} · ${plural(f.holds || 0, "hold")}`;
}
function resultText(r){
  if (r.status === "error") return ["Catalog unavailable", r.error ? `Could not check catalog: ${r.error}` : "Could not check Richland Library right now.", "error"];
  if (r.status === "not_owned") return ["Not in collection", "No matching Richland Library title found.", "none"];
  if (Array.isArray(r.formats) && r.formats.length) {
    // The per-format rows already contain the useful copy counts. Do not repeat
    // a combined physical-copy total as a large headline above them.
    return ["", "Availability by format and service", (r.available || 0) > 0 || r.formats.some(f=>f.digital && (f.always || (Number.isFinite(f.available)&&f.available>0) || /available now/i.test(f.statusText||""))) ? "yes" : "owned"];
  }
  if (r.available == null) return ["In collection", "Richland Library owns this title; live copy count was not shown by the catalog.", "owned"];
  const copies = r.total == null ? `${r.available} available` : `${r.available} of ${r.total} available`;
  return [copies, `${plural(r.holds || 0,"hold")} · Richland Library`, r.available > 0 ? "yes" : "owned"];
}
function makeCard(r, compact=false){
  const [headline, sub, state] = resultText(r);
  const el=document.createElement('div'); el.className=`rl-card rl-${state}${compact?' rl-compact':''}`;
  el.innerHTML=`<div class="rl-brand">RICHLAND LIBRARY</div><div class="rl-headline"></div><div class="rl-sub"></div><div class="rl-formats"></div><a class="rl-link" target="_blank" rel="noopener">View in catalog ↗</a>`;
  const headlineEl = el.querySelector('.rl-headline');
  if (headline) headlineEl.textContent=headline;
  else headlineEl.remove();
  el.querySelector('.rl-sub').textContent=sub;
  const formats = el.querySelector('.rl-formats');
  if (Array.isArray(r.formats) && r.formats.length) {
    for (const f of r.formats) {
      const row=document.createElement('div'); row.className='rl-format-row';
      const name=document.createElement(f.url ? 'a' : 'div'); name.className='rl-format-name'; name.textContent=f.format;
      if (f.url) { name.href=f.url; name.target='_blank'; name.rel='noopener'; name.classList.add('rl-format-link'); }
      const counts=document.createElement('div'); counts.className='rl-format-counts'; counts.textContent=formatLine(f);
      row.append(name,counts); formats.append(row);
    }
  } else {
    formats.remove();
  }
  el.querySelector('.rl-link').href=r.catalogUrl || 'https://catalog.richlandlibrary.com/polaris/';
  return el;
}
function loading(compact=false){ const e=document.createElement('div'); e.className=`rl-card rl-loading${compact?' rl-compact':''}`; e.innerHTML='<div class="rl-brand">RICHLAND LIBRARY</div><div class="rl-headline">Checking catalog…</div>'; return e; }
async function lookup(q){ try { return await API.runtime.sendMessage({type:'RL_LOOKUP',...q}); } catch(e){ return {status:'error',error:String(e)}; } }

async function bookPage(){
  if (!/\/book\/show\//.test(location.pathname) || document.querySelector('#rl-goodreads-book')) return;
  const title=titleFromBookPage(); if(!title) return;
  const host=document.createElement('aside'); host.id='rl-goodreads-book'; host.append(loading()); document.body.append(host);
  const r=await lookup({title,author:authorFromBookPage(),isbn:isbnFromPage()}); host.replaceChildren(makeCard(r));
}

function findRows(){
  const selectors=['table.tableList tr','table[aria-label] tr','.BookListItem','[class*="BookListItem"]'];
  for(const s of selectors){ const a=[...document.querySelectorAll(s)].filter(x=>x.querySelector('a[href*="/book/show/"]')); if(a.length) return a; }
  return [];
}
function rowInfo(row){
  const anchors=[...row.querySelectorAll('a.bookTitle, a[href*="/book/show/"]')];
  const a=anchors.find(x=>clean(x.textContent)) || anchors[0];
  let title=clean(a?.textContent || a?.querySelector('img')?.alt);
  const auth=[...row.querySelectorAll('a.authorName, a[href*="/author/show/"]')].find(x=>clean(x.textContent));
  return {title,author:clean(auth?.textContent)};
}
async function enhanceRow(row){
  if(seen.has(row)) return; seen.add(row); const q=rowInfo(row); if(!q.title) return;
  if(row.tagName==='TR'){
    const td=document.createElement('td'); td.className='rl-list-cell'; td.append(loading(true)); row.append(td);
    const r=await lookup(q); td.replaceChildren(makeCard(r,true));
  } else {
    const cell=document.createElement('div'); cell.className='rl-modern-list-cell'; cell.append(loading(true)); row.append(cell);
    const r=await lookup(q); cell.replaceChildren(makeCard(r,true));
  }
}
function addHeader(){
  const table=document.querySelector('table.tableList'); if(!table || table.dataset.rlHeader) return; table.dataset.rlHeader='1';
  const hr=table.querySelector('tr'); if(hr && !hr.querySelector('a[href*="/book/show/"]')) { const th=document.createElement('th'); th.className='rl-list-header'; th.textContent='Richland Library'; hr.append(th); }
}
function scan(){ bookPage(); addHeader(); findRows().forEach(enhanceRow); }
scan();
const obs=new MutationObserver(()=>{ clearTimeout(window.__rlTimer); window.__rlTimer=setTimeout(scan,250); });
obs.observe(document.documentElement,{childList:true,subtree:true});