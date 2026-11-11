/* Richland Library on Goodreads — background catalog client (v2.3).
   Polaris search state is session-based, so requests are deliberately serialized. */
const API = typeof browser !== "undefined" ? browser : chrome;
const BASES = [
  "https://rlcpac/polaris",
  "http://rlcpac/polaris",
  "https://catalog.richlandlibrary.com/polaris",
  "http://catalog.richlandlibrary.com/polaris"
];
let activeBase = BASES[0];
const CTX = "1.1033.0.0.1";
const cache = new Map();
let queue = Promise.resolve();

API.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "RL_LOOKUP") return;
  const key = `${msg.isbn || ""}|${msg.title || ""}|${msg.author || ""}`.toLowerCase();
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const job = queue.then(() => lookup(msg)).catch(err => ({status:"error", error:String(err.message || err), catalogUrl: makeSearchUrl(msg)}));
  queue = job.then(() => undefined, () => undefined);
  return job.then(result => { cache.set(key, result); setTimeout(() => cache.delete(key), 10 * 60 * 1000); return result; });
});

function makeSearchUrl({isbn, title}, base = activeBase, mode = "title") {
  // Polaris documents searchresults.aspx as a deep-link endpoint.  searchid is
  // session-specific, so hard-coding searchid=1 can resurrect the first search
  // performed in the session (the Lafayette bug).  Omit it entirely.
  const useIsbn = mode === "isbn" && !!isbn;
  const term = (useIsbn ? isbn : title || "").trim();
  const by = useIsbn ? "ISBN" : "TI";
  const u = new URL(`${base}/search/searchresults.aspx`);
  u.search = new URLSearchParams({ctx:CTX, type:"Keyword", term, by, sort:"RELEVANCE", limit:"TOM=*", page:"0"});
  return u.href;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.withCredentials = true;
    xhr.timeout = 20000;
    xhr.setRequestHeader("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 400) resolve(xhr.responseText || "");
      else reject(new Error(`HTTP ${xhr.status} at ${xhr.responseURL || url}`));
    };
    xhr.onerror = () => reject(new Error(`XHR network failure at ${xhr.responseURL || url}`));
    xhr.ontimeout = () => reject(new Error(`Timed out after 20s at ${url}`));
    xhr.onabort = () => reject(new Error(`Request aborted at ${url}`));
    try { xhr.send(); } catch (e) { reject(new Error(`XHR send failed: ${e.message || e}`)); }
  });
}

function getJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method || "GET", url, true);
    xhr.withCredentials = false;
    xhr.timeout = options.timeout || 20000;
    xhr.setRequestHeader("Accept", "application/json");
    if (options.body != null) xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 400) {
        try { resolve(JSON.parse(xhr.responseText || "null")); }
        catch (e) { reject(new Error(`Invalid JSON from ${xhr.responseURL || url}`)); }
      } else reject(new Error(`HTTP ${xhr.status} at ${xhr.responseURL || url}`));
    };
    xhr.onerror = () => reject(new Error(`XHR network failure at ${xhr.responseURL || url}`));
    xhr.ontimeout = () => reject(new Error(`Timed out after ${Math.round((options.timeout || 20000)/1000)}s at ${url}`));
    try { xhr.send(options.body == null ? null : JSON.stringify(options.body)); }
    catch (e) { reject(new Error(`XHR send failed: ${e.message || e}`)); }
  });
}

async function lookup(q) {
  if (API.permissions && API.permissions.contains) {
    const publicGranted = await API.permissions.contains({origins:["https://catalog.richlandlibrary.com/*"]});
    const internalGranted = await API.permissions.contains({origins:["https://rlcpac/*"]});
    if (!publicGranted || !internalGranted) {
      throw new Error(`Firefox host permissions incomplete (catalog=${publicGranted}, rlcpac=${internalGranted})`);
    }
  }

  const errors = [];
  let physicalResult = null;
  let finalCatalogUrl = makeSearchUrl(q);

  // Search by TITLE first. Goodreads often exposes the ISBN of one specific
  // edition, while Richland may own a different edition. ISBN-first searching
  // made perfectly ordinary owned titles look absent.
  for (const base of BASES) {
    try {
      activeBase = base;
      const catalogUrl = makeSearchUrl(q, base, "title");
      finalCatalogUrl = catalogUrl;
      const shell = await get(catalogUrl);
      let html = shell;
      try {
        // If Polaris paints the result list through its AJAX fragment, this
        // request runs after the title deep-link established the current search.
        const ajax = await get(`${base}/search/components/ajaxResults.aspx?page=1&hpp=10&_=${Date.now()}`);
        if (ajax && ajax.length > 100) html = ajax;
      } catch (_) {}

      let records = parsePolarisRecords(html, q, base);

      // Rare fallback: a title search can fail on punctuation/edition oddities.
      // Only then try the Goodreads ISBN. This never replaces the title link.
      if (!records.length && q.isbn) {
        try {
          const isbnUrl = makeSearchUrl(q, base, "isbn");
          const isbnHtml = await get(isbnUrl);
          records = parsePolarisRecords(isbnHtml, q, base);
        } catch (_) {}
      }

      for (const record of records) {
        if (record.available == null || record.total == null) {
          await enrichRecordAvailability(record, base);
        }
      }
      physicalResult = finalizeRecords(records);
      // A successful request is enough. Do not allow another base to resurrect
      // an earlier session's search results.
      break;
    } catch (e) {
      const label = base.includes("rlcpac") ? (base.startsWith("https:") ? "RLCPAC HTTPS" : "RLCPAC HTTP") : (base.startsWith("https:") ? "PUBLIC HTTPS" : "PUBLIC HTTP");
      errors.push(`${label}: ${e.message || e}`);
    }
  }

  // Libby/hoopla are checked independently. A title can be digital-only even
  // when Polaris has no matching physical record.
  let digital = [];
  try { digital = await lookupDigital(q); } catch (_) {}

  if (!physicalResult && !digital.length) {
    if (errors.length) throw new Error(errors.join(" | "));
    return {status:"not_owned", available:0, total:0, formats:[], catalogUrl:finalCatalogUrl};
  }

  const physicalFormats = (physicalResult?.formats || []).filter(f => !/^e(?:Book|Audiobook)$/i.test(f.format || ""));
  const formats = [...physicalFormats, ...digital.map(digitalToFormatRow)];
  if (!formats.length) return {status:"not_owned", available:0, total:0, formats:[], catalogUrl:finalCatalogUrl};

  const known = formats.filter(f => !f.digital && f.available != null && f.total != null);
  const available = known.length ? known.reduce((n,f)=>n+f.available,0) : null;
  const total = known.length ? known.reduce((n,f)=>n+f.total,0) : null;
  const holds = formats.reduce((n,f)=>n+(Number.isFinite(f.holds)?f.holds:0),0);
  return {
    status:"owned", available, total, holds, formats,
    recordsParsed: physicalResult?.recordsParsed || 0,
    digitalProvidersChecked:["Libby","hoopla"],
    catalogUrl:finalCatalogUrl
  };
}

function norm(s) {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function titleCore(s) { return norm(s).replace(/\b(a|an|the)\b/g, " ").replace(/\s+/g," ").trim(); }
function decodeEntities(s) {
  return (s || "").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&#39;|&apos;/gi,"'")
    .replace(/&quot;/gi,'"').replace(/&lt;/gi,"<").replace(/&gt;/gi,">");
}
function stripTags(s) {
  return decodeEntities((s || "").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
}
function attributeText(s) {
  const out = [];
  const re = /\b(?:alt|title|src|class|aria-label)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(s || ""))) out.push(decodeEntities(m[1]));
  return out.join(" ");
}

function authorLooksLikeTarget(text, authorName) {
  const hay = norm(text);
  const a = norm(authorName || "");
  if (!a) return true;

  // Goodreads normally supplies "Sarah Vowell", while Polaris commonly renders
  // authority headings as "Vowell, Sarah, 1969-".  Requiring the literal full
  // name therefore rejects perfectly good matches.  Accept either name order,
  // and fall back to surname + first-name matching.
  const parts = a.split(/\s+/).filter(Boolean);
  if (!parts.length) return true;
  if (hay.includes(a)) return true;

  const first = parts[0];
  const last = parts[parts.length - 1];
  if (hay.includes(`${last} ${first}`)) return true;
  if (hay.includes(last) && (parts.length === 1 || hay.includes(first))) return true;
  return false;
}

function looksLikeTarget(text, q) {
  const target = titleCore(q.title);
  const nt = titleCore(text);
  if (q.isbn && text.replace(/[^0-9Xx]/g,"").includes(q.isbn.replace(/[^0-9Xx]/g,""))) return true;
  if (!target || !nt.includes(target)) return false;
  // The result card itself can omit the author for some e-content records.
  // Once the title matches, do not discard a valid format solely for that.
  return true;
}

function elementMeta(el) {
  if (!el) return "";
  const bits = [el.textContent || "", el.id || "", el.className || ""];
  try {
    for (const node of el.querySelectorAll("img, input, a, span, div")) {
      for (const name of ["alt", "title", "src", "class", "id", "aria-label", "data-original-title"]) {
        const v = node.getAttribute && node.getAttribute(name);
        if (v) bits.push(v);
      }
    }
  } catch (_) {}
  return bits.join(" ");
}

function hasAvailabilityText(text) {
  return /\bavailable(?:\s+copies?)?\b/i.test(text || "");
}
function hasNumericAvailability(text) {
  // Richland's Polaris uses both "Available (0 of 3)" and
  // "Available copies: 2 (of 5)". The latter has the opening parenthesis
  // *between* the available count and "of", which older versions missed.
  return /\bavailable(?:\s+copies?)?\s*[:\-]?\s*(?:\(\s*)?\d+\s*(?:\(\s*)?(?:\/|of)\s*\d+\s*\)?/i.test(cleanText(text || ""));
}

function titleAnchorMatches(anchorText, wantedTitle) {
  const a = titleCore(anchorText);
  const t = titleCore(wantedTitle);
  if (!a || !t) return false;
  return a === t || a.includes(t) || t.includes(a);
}

function extractResultElements(html, q) {
  if (typeof DOMParser === "undefined") return [];
  let doc;
  try { doc = new DOMParser().parseFromString(html || "", "text/html"); }
  catch (_) { return []; }

  const candidates = [];
  // Polaris 8 exposes one title group per result. Starting from that stable
  // element is much safer than starting from every matching anchor.
  const titleGroups = [...doc.querySelectorAll(".nsm-brief-primary-title-group")];
  const seeds = titleGroups.length ? titleGroups : [...doc.querySelectorAll("a")];

  for (const seed of seeds) {
    const anchor = seed.matches && seed.matches("a") ? seed : seed.querySelector?.("a.nsm-brief-action-link, a");
    const anchorText = cleanText(anchor?.textContent || seed.textContent || "");
    if (!titleAnchorMatches(anchorText, q.title)) continue;

    let el = seed;
    let best = null;
    let bestNumeric = null;
    for (let depth = 0; el && depth < 14; depth++, el = el.parentElement) {
      const text = cleanText(el.textContent || "");
      let matchingTitles = 0;
      try {
        const groups = el.querySelectorAll(".nsm-brief-primary-title-group");
        if (groups.length) matchingTitles = [...groups].filter(g => titleAnchorMatches(g.textContent || "", q.title)).length;
        else matchingTitles = [...el.querySelectorAll("a")].filter(a => titleAnchorMatches(a.textContent || "", q.title)).length;
      } catch (_) {}
      if (matchingTitles > 1) break; // we have climbed into the multi-result container

      const useful = /full\s+display|place\s+hold|publishing|published|owner\s+holds?|requests?|availability/i.test(text);
      if (useful && text.length < 12000) best = el;
      if (hasNumericAvailability(text) && text.length < 12000) { bestNumeric = el; break; }
    }
    const chosen = bestNumeric || best;
    if (chosen && !candidates.includes(chosen)) candidates.push(chosen);
  }

  // Keep one container per result.
  return candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
}

function cleanText(s) {
  return decodeEntities(s || "").replace(/\s+/g, " ").trim();
}

function splitResultChunks(html) {
  // Regex fallback for contexts where DOMParser is unavailable or Polaris changes markup.
  let chunks = (html || "").split(/(?=<(?:div|li|tr)[^>]+(?:class|id)=["'][^"']*(?:nsm-brief-primary|nsm-brief|brief-primary|brief|searchresult|search-result|result-item|bib-result)[^"']*["'])/i);
  chunks = chunks.filter(x => /available|requests|owner holds|full display|place hold/i.test(x));
  if (chunks.length > 1) return chunks;

  const marker = /(?=(?:^|>)[\s\r\n]*(?:<[^>]+>[\s\r\n]*)*\d+\.\s*(?:<[^>]+>[\s\r\n]*)*<a\b)/gi;
  const flat = (html || "").split(marker).filter(x => /available|requests|owner holds|full display|place hold/i.test(x));
  return flat.length ? flat : [html];
}

function parseAvailability(text) {
  const t = cleanText(text);
  const patterns = [
    // Polaris search results: "Available copies: 2 (of 5)"
    // Other records:          "Available (0 of 3)" / "Available copies (0 of 5)"
    /\bavailable(?:\s+copies?)?\s*[:\-]?\s*(?:\(\s*)?(\d+)\s*(?:\(\s*)?(?:\/|of)\s*(\d+)\s*\)?/i,
    /\b(\d+)\s+(?:copies?|items?)\s+available\s+(?:of|out of)\s+(\d+)/i,
    /\b(\d+)\s+(?:of|out of)\s+(\d+)\s+(?:copies?|items?)\s+available/i,
    /\b(\d+)\s+available\s*(?:\/|of)\s*(\d+)/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return {available:+m[1], total:+m[2]};
  }
  return {available:null, total:null};
}

function parseHoldsMaybe(text) {
  // Polaris uses several labels for the same title-level demand count.
  // Return null when the page does not expose a count so we do not turn
  // "unknown" into a misleading zero.
  const t = cleanText(text || "");
  const patterns = [
    /\bowner\s+holds?\s*[:\-]?\s*(\d+)/i,
    /\bcurrent\s+holds?\s*[:\-]?\s*(\d+)/i,
    /\bno\.?\s*(?:of\s+)?requests?\s*[:\-]?\s*(\d+)/i,
    /\brequests?\s*[:\-]?\s*(\d+)/i,
    /\bholds?\s*[:\-]?\s*(\d+)/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return +m[1];
  }
  return null;
}
function parseHolds(text) {
  const n = parseHoldsMaybe(text);
  return n == null ? 0 : n;
}

function detectFormat(source, text) {
  // source may be an Element (preferred) or an HTML string (fallback).
  let meta = text || "";
  if (source && typeof source === "object" && source.nodeType === 1) meta += " " + elementMeta(source);
  else meta += " " + attributeText(source || "");
  meta = cleanText(meta).toLowerCase();

  if (/\blarge\s*print\b|thorndike\s+press/.test(meta)) return "Large Print";
  if (/\beaudiobook\b|e-audiobook|electronic audiobook|downloadable audiobook|digital audiobook/.test(meta)) return "eAudiobook";
  if (/\baudio\s*books?\b|\baudiobook\b|compact disc|sound recording|simon\s*&\s*schuster\s+audio|blackstone\s+audio|recorded\s+books/.test(meta)) return "Audiobook";
  if (/\boverdrive\b|\bebook\b|e-book|electronic book|downloadable book/.test(meta)) return "eBook";
  return "Book";
}

function aggregateFormats(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = e.format || "Book";
    if (!groups.has(key)) groups.set(key, {format:key, available:0, total:0, holds:0, availabilityKnown:true, records:0});
    const g = groups.get(key);
    g.records++;
    g.holds += Number.isFinite(e.holds) ? e.holds : 0;
    if (e.available == null || e.total == null) {
      g.availabilityKnown = false;
    } else {
      g.available += e.available;
      g.total += e.total;
    }
  }
  return [...groups.values()].map(g => ({
    format:g.format,
    available:g.availabilityKnown ? g.available : null,
    total:g.availabilityKnown ? g.total : null,
    holds:g.holds,
    records:g.records
  }));
}

function absolutePolarisUrl(value, base) {
  if (!value) return null;
  let v = decodeEntities(String(value)).trim();
  // Pull a URL out of common javascript handlers such as window.location='...'
  // or OpenWindow('...').
  const quoted = v.match(/["']([^"']*(?:title|availability|holdings|item|display|bib)[^"']*)["']/i);
  if (!/^https?:/i.test(v) && quoted) v = quoted[1];
  if (/^javascript:/i.test(v)) return null;
  try { return new URL(v, base.endsWith('/') ? base : base + '/').href; }
  catch (_) { return null; }
}

function actionUrlsFromElement(el, base) {
  const urls = [];
  if (!el || !el.querySelectorAll) return urls;
  const nodes = [el, ...el.querySelectorAll('a,button,input,[onclick],[data-href],[data-url]')];
  for (const node of nodes) {
    const label = cleanText([
      node.textContent || '',
      node.getAttribute?.('title') || '',
      node.getAttribute?.('aria-label') || '',
      node.getAttribute?.('value') || '',
      node.getAttribute?.('class') || ''
    ].join(' '));
    const attrs = ['href','data-href','data-url','onclick','formaction'];
    for (const attr of attrs) {
      const raw = node.getAttribute?.(attr);
      if (!raw) continue;
      const u = absolutePolarisUrl(raw, base);
      if (!u) continue;
      const kind = /avail|holding|item/i.test(label + ' ' + raw) ? 'availability' : /full\s*display|title\.aspx|bib/i.test(label + ' ' + raw) ? 'detail' : 'other';
      urls.push({url:u, kind});
    }
  }
  const seen = new Set();
  return urls.filter(x => !seen.has(x.url) && seen.add(x.url));
}

function parsePolarisRecords(html, q, base) {
  const wholeText = stripTags(html);
  if (/no (titles|results|matches) (were )?found|0 results|your search.*no results/i.test(wholeText)) return [];
  const records = [];
  const elements = extractResultElements(html, q);
  for (const el of elements) {
    const text = cleanText(el.textContent || '');
    if (!looksLikeTarget(text, q)) continue;
    const {available, total} = parseAvailability(text);
    records.push({
      format: detectFormat(el, text),
      available, total,
      holds: parseHolds(text),
      raw: text.slice(0,1200),
      urls: actionUrlsFromElement(el, base)
    });
  }
  if (!records.length) {
    const chunks = splitResultChunks(html);
    for (const chunk of chunks) {
      const text = stripTags(chunk);
      if (!looksLikeTarget(text, q)) continue;
      const {available, total} = parseAvailability(text);
      // Regex fallback can still discover ordinary hrefs.
      const urls = [];
      const hrefRe = /(?:href|data-href|data-url)\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = hrefRe.exec(chunk))) {
        const u = absolutePolarisUrl(m[1], base);
        if (u) urls.push({url:u, kind:/avail|holding|item/i.test(m[1])?'availability':/title|display|bib/i.test(m[1])?'detail':'other'});
      }
      records.push({format:detectFormat(chunk,text), available,total, holds:parseHolds(text), raw:text.slice(0,1200), urls});
    }
  }
  return records;
}

function availabilityFromAnyHtml(html) {
  // Prefer Polaris's title-level aggregate.  A previous version counted DOM
  // nodes in the Availability panel and could turn one copy into several
  // because nested containers repeated the word "Available".  Wrong numbers
  // are worse than no numbers, so this parser intentionally accepts only an
  // explicit aggregate supplied by Polaris.
  const text = stripTags(html);
  const a = parseAvailability(text);
  if (a.available != null && a.total != null) return a;

  // Some Polaris title pages render the fields as:
  //   AVAILABLE COPIES: 3    # System items in: 5
  // instead of "3 (of 5)".  Use that pair only when both values are present.
  const availableOnly = text.match(/\bavailable\s+copies?\s*[:\-]?\s*(\d+)\b/i);
  const systemTotal = text.match(/#?\s*system\s+items?\s+in\s*[:\-]?\s*(\d+)\b/i);
  if (availableOnly && systemTotal) {
    return {available:+availableOnly[1], total:+systemTotal[1]};
  }
  return {available:null,total:null};
}

async function enrichRecordAvailability(record, base) {
  // Full Display / title.aspx is the authoritative source for the aggregate
  // "Available Copies: x (of y)" field.  The expandable Availability panel is
  // useful to humans but its nested markup caused v2.0 to over-count copies.
  // Therefore try detail pages first and only then other action URLs.
  const rank = action => {
    const u = action?.url || "";
    if (/\/search\/title\.aspx/i.test(u)) return 0;
    if (action?.kind === "detail") return 1;
    if (action?.kind === "availability") return 2;
    return 3;
  };
  const ordered = [...(record.urls || [])].sort((a,b) => rank(a) - rank(b));
  const tried = new Set();

  for (const action of ordered) {
    if (!action?.url || tried.has(action.url)) continue;
    tried.add(action.url);
    try {
      const html = await get(action.url);
      const found = availabilityFromAnyHtml(html);
      const pageHolds = parseHoldsMaybe(stripTags(html));
      if (pageHolds != null) record.holds = pageHolds;
      if (found.available != null && found.total != null) {
        record.available = found.available;
        record.total = found.total;
        return;
      }

      // A Full Display page may expose another title/detail URL after the first
      // request. Follow only exact detail pages here. We deliberately do not
      // infer totals by counting rows in an Availability widget.
      if (typeof DOMParser !== "undefined") {
        try {
          const doc = new DOMParser().parseFromString(html || "", "text/html");
          const extra = actionUrlsFromElement(doc.body, base)
            .filter(x => x.kind === "detail" || /\/search\/title\.aspx/i.test(x.url || ""));
          for (const x of extra.slice(0,4)) {
            if (!x.url || tried.has(x.url)) continue;
            tried.add(x.url);
            try {
              const h2 = await get(x.url);
              const f2 = availabilityFromAnyHtml(h2);
              const h2Holds = parseHoldsMaybe(stripTags(h2));
              if (h2Holds != null) record.holds = h2Holds;
              if (f2.available != null && f2.total != null) {
                record.available = f2.available;
                record.total = f2.total;
                return;
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
}

function finalizeRecords(matches) {
  if (!matches.length) return {status:'not_owned', available:0, total:0, formats:[]};
  const formats = aggregateFormats(matches);
  const known = formats.filter(f => f.available != null && f.total != null);
  const available = known.length === formats.length ? known.reduce((n,f)=>n+f.available,0) : null;
  const total = known.length === formats.length ? known.reduce((n,f)=>n+f.total,0) : null;
  const holds = formats.reduce((n,f)=>n+(f.holds || 0),0);
  return {
    status:'owned', available, total, holds, formats,
    recordsParsed:matches.length,
    raw:matches.map(m=>m.raw).join(' || ').slice(0,3200)
  };
}

// ---------- Digital providers: Libby / OverDrive and hoopla ----------
const LIBBY_BASE = "https://myrl.overdrive.com";
const THUNDER_BASE = "https://thunder.api.overdrive.com/v2";
const HOOPLA_BASE = "https://www.hoopladigital.com";
let libbyLibraryIdPromise = null;
let hooplaEbookTabQueue = Promise.resolve();
let hooplaAudiobookTabQueue = Promise.resolve();

function titleMatchText(a, b) {
  const x = titleCore(a), y = titleCore(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}
function authorLastName(author) {
  const parts = norm(author || "").split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
function libbyMediaList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["items","media","results","titles","data"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}
function libbyAuthorText(item) {
  const bits = [item?.firstCreatorName, item?.primaryCreator?.name];
  for (const c of (item?.creators || [])) bits.push(c?.name, c?.creatorName);
  return bits.filter(Boolean).join(" ");
}
function libbyFormat(item) {
  const t = `${item?.type?.id || ""} ${item?.type?.name || ""} ${(item?.formats || []).map(f=>`${f?.id||""} ${f?.name||""}`).join(" ")}`.toLowerCase();
  if (/audio/.test(t)) return "eAudiobook";
  if (/ebook|kindle|epub|overdrive read/.test(t)) return "eBook";
  return null;
}
function libbyMediaUrl(item) {
  const id = item?.reserveId || item?.id;
  if (id) return `${LIBBY_BASE}/media/${encodeURIComponent(id)}`;
  return `${LIBBY_BASE}/search?query=${encodeURIComponent(item?.title || "")}`;
}
function libbyStatus(item) {
  const always = String(item?.availabilityType || "").toLowerCase() === "always";
  const available = Number.isFinite(item?.availableCopies) ? item.availableCopies : (item?.isAvailable ? 1 : 0);
  const total = Number.isFinite(item?.ownedCopies) ? item.ownedCopies : null;
  const holds = Number.isFinite(item?.holdsCount) ? item.holdsCount : 0;
  let statusText = always ? "Always available" : (item?.isAvailable || available > 0) ? "Available now" : "Wait list";
  return {statusText, available: always ? null : available, total: always ? null : total, holds, always};
}

async function resolveLibbyLibraryId() {
  if (libbyLibraryIdPromise) return libbyLibraryIdPromise;
  libbyLibraryIdPromise = (async () => {
    // Richland's OverDrive hostname is myrl.overdrive.com, and OverDrive library
    // IDs are commonly the same slug. Try that first, then discover by name.
    try {
      const direct = await getJson(`${THUNDER_BASE}/libraries/myrl`);
      if (direct?.id) return direct.id;
    } catch (_) {}
    for (let page=1; page<=6; page++) {
      try {
        const data = await getJson(`${THUNDER_BASE}/libraries?page=${page}&perPage=100`);
        const list = Array.isArray(data) ? data : (data?.items || data?.libraries || data?.results || []);
        const match = list.find(x => norm(x?.name) === "richland library" || (norm(x?.name).includes("richland library") && /south carolina|\bsc\b/.test(norm(`${x?.name||""} ${x?.city||""} ${x?.state||""}`))));
        if (match?.id) return match.id;
      } catch (_) {}
    }
    // Keep the likely slug as a last attempt. The media request will fail cleanly
    // if OverDrive changes it.
    return "myrl";
  })();
  return libbyLibraryIdPromise;
}

async function searchLibby(q) {
  const libraryId = await resolveLibbyLibraryId();
  const last = authorLastName(q.author);
  const terms = [];
  if (q.title && last) terms.push(`${q.title} ${last}`);
  if (q.title) terms.push(q.title);
  const seenTerm = new Set();
  let candidates = [];
  for (const term of terms) {
    if (!term || seenTerm.has(norm(term))) continue;
    seenTerm.add(norm(term));
    try {
      const data = await getJson(`${THUNDER_BASE}/libraries/${encodeURIComponent(libraryId)}/media?query=${encodeURIComponent(term)}&perPage=25`);
      candidates = libbyMediaList(data);
      if (candidates.length) break;
    } catch (_) {}
  }
  const out = [];
  const seen = new Set();
  for (const item of candidates) {
    if (!titleMatchText(item?.title || item?.sortTitle || "", q.title)) continue;
    const author = libbyAuthorText(item);
    if (q.author && author && !authorLooksLikeTarget(author, q.author)) continue;
    const fmt = libbyFormat(item);
    if (!fmt) continue;
    const key = `${fmt}|${item?.id || item?.reserveId || item?.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const st = libbyStatus(item);
    out.push({provider:"Libby",format:fmt,url:libbyMediaUrl(item),...st});
  }
  return out;
}

function hooplaSearchUrl(q) {
  // Match Hoopla's current direct-search URL. Keeping scope/type explicit avoids
  // landing on a generic discovery state that may not render title cards.
  const u = new URL(`${HOOPLA_BASE}/search`);
  u.search = new URLSearchParams({q:(q.title || "").trim(), scope:"everything", type:"direct"});
  return u.href;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function waitForTabComplete(tabId, timeout=18000) {
  return new Promise(async (resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return; done = true;
      clearTimeout(timer);
      API.tabs.onUpdated.removeListener(listener);
      err ? reject(err) : resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    API.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(new Error("hoopla tab load timeout")), timeout);
    try {
      const t = await API.tabs.get(tabId);
      if (t?.status === "complete") finish();
    } catch (e) { finish(e); }
  });
}
function hooplaScanCode(q, targetFormat) {
  const data = JSON.stringify({title:q.title || "",author:q.author || "",searchUrl:hooplaSearchUrl(q),targetFormat});
  return `(() => {\n`+
`const q=${data};\n`+
`const norm=s=>(s||'').toLowerCase().normalize('NFKD').replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();\n`+
`const core=s=>norm(s).replace(/\\b(a|an|the)\\b/g,' ').replace(/\\s+/g,' ').trim();\n`+
`const tm=(a,b)=>{const x=core(a),y=core(b);return !!x&&!!y&&(x===y||x.includes(y)||y.includes(x));};\n`+
`const last=norm(q.author).split(/\\s+/).filter(Boolean).pop()||'';\n`+
`const targetFmt=q.targetFormat==='eAudiobook'?'eAudiobook':'eBook';\n`+
`const out=[],seen=new Set();\n`+
`const textOf=el=>(el?.innerText||el?.textContent||'').replace(/\\s+/g,' ').trim();\n`+
`const hrefKind=href=>/\\/audiobook\\//i.test(href)?'eAudiobook':/\\/ebook\\//i.test(href)?'eBook':null;\n`+
`const textKind=text=>/\\baudiobooks?\\b/i.test(text)?'eAudiobook':/\\be[ -]?books?\\b/i.test(text)?'eBook':null;\n`+
`const cardFor=el=>{let x=el,best=el; for(let i=0;i<9&&x;i++,x=x.parentElement){const t=textOf(x); if(t.length>=10&&t.length<2200) best=x; if(t.length>=2200) break; if(x.matches?.('article,li,[role="listitem"],[data-testid*="card" i],[data-testid*="title" i]')) {best=x; break;}} return best;};\n`+
`const add=(el,hrefHint)=>{const card=cardFor(el); const text=textOf(card); const own=textOf(el); const imgAlt=el?.querySelector?.('img')?.alt||el?.closest?.('a')?.querySelector?.('img')?.alt||''; const aria=el?.getAttribute?.('aria-label')||''; const titleish=[own,imgAlt,aria,text].filter(Boolean).join(' '); if(!tm(titleish,q.title)) return; if(last&&!norm(text).includes(last)){const exact=[own,imgAlt,aria].some(v=>core(v)===core(q.title)); if(!exact) return;} let link=hrefHint||''; if(!link){const links=[...card.querySelectorAll?.('a[href]')||[]]; const wanted=targetFmt==='eAudiobook'?/\\/audiobook\\//i:/\\/ebook\\//i; const found=links.find(a=>wanted.test(a.href||''))||links.find(a=>/\\/title\\//i.test(a.href||'')); link=found?.href||'';} let fmt=hrefKind(link)||textKind(text); if(!fmt&&/\\/title\\//i.test(link)){fmt=textKind(text);} if(!fmt||fmt!==targetFmt) return; const key=fmt+'|'+(link||q.searchUrl); if(seen.has(key)) return; seen.add(key); out.push({provider:'hoopla',format:fmt,statusText:'Available now',holds:null,available:null,total:null,url:link||q.searchUrl});};\n`+
`for(const a of document.querySelectorAll('main a[href], a[href]')){const href=a.href||''; if(!/\\/(?:audiobook|ebook|title)\\//i.test(href)) continue; add(a,href);}\n`+
`if(!out.length){for(const el of document.querySelectorAll('main h1,main h2,main h3,main h4,main [aria-label],main img[alt],main p,main span,main div')){const own=[textOf(el),el.getAttribute?.('aria-label')||'',el.getAttribute?.('alt')||''].join(' '); if(!tm(own,q.title)) continue; add(el,'');}}\n`+
`return {rows:out,ready:document.readyState,bodyHasTitle:core(document.body?.innerText||'').includes(core(q.title)),url:location.href};})()`;
}
function hooplaSubmitSearchCode(q) {
  const title = JSON.stringify(q.title || "");
  return `(() => { const title=${title}; const input=[...document.querySelectorAll('input')].find(i=>/search/i.test([i.type,i.placeholder,i.getAttribute('aria-label')].join(' '))); if(!input) return false; input.focus(); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set; if(set) set.call(input,title); else input.value=title; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); const form=input.closest('form'); if(form){ if(form.requestSubmit) form.requestSubmit(); else form.submit(); return true; } input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true})); input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true})); return true; })()`;
}

async function searchHooplaFormatInHiddenTab(q, targetFormat) {
  // v2.5 starts one independent hidden-tab search for each Hoopla format.
  // Each search owns its own tab, polling loop, retry state, and timeout. A
  // result or timeout in one format cannot end the other format's search.
  // Matching otherwise remains the v2.3 matching logic.
  if (!API.tabs?.create || !q.title) return [];
  let tab = null;
  try {
    tab = await API.tabs.create({url:hooplaSearchUrl(q), active:false});
    await waitForTabComplete(tab.id);

    let submitted = false;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try {
        const res = await API.tabs.executeScript(tab.id,{code:hooplaScanCode(q, targetFormat)});
        const payload = Array.isArray(res) ? res[0] : null;
        const rows = Array.isArray(payload?.rows) ? payload.rows.filter(r => r?.format === targetFormat) : [];
        if (rows.length) return rows.slice(0, 1);

        // If this format's Hoopla tab redirected to a generic page or did not
        // hydrate the query, submit the visible search box once for this tab.
        if (!submitted && payload && payload.bodyHasTitle === false && Date.now() + 5000 < deadline) {
          submitted = true;
          try { await API.tabs.executeScript(tab.id,{code:hooplaSubmitSearchCode(q)}); } catch (_) {}
        }
      } catch (_) {}
      await delay(900);
    }
    return [];
  } finally {
    if (tab?.id != null) { try { await API.tabs.remove(tab.id); } catch (_) {} }
  }
}

function searchHooplaFormat(q, targetFormat) {
  const run = () => searchHooplaFormatInHiddenTab(q, targetFormat);
  if (targetFormat === "eAudiobook") {
    const job = hooplaAudiobookTabQueue.then(run, run);
    hooplaAudiobookTabQueue = job.then(()=>undefined,()=>undefined);
    return job;
  }
  const job = hooplaEbookTabQueue.then(run, run);
  hooplaEbookTabQueue = job.then(()=>undefined,()=>undefined);
  return job;
}

async function searchHoopla(q) {
  // These are deliberately concurrent and fully independent. The eBook tab may
  // finish immediately while the eAudiobook tab keeps polling for the full
  // timeout, or vice versa.
  const [ebooks, audiobooks] = await Promise.all([
    searchHooplaFormat(q, "eBook").catch(() => []),
    searchHooplaFormat(q, "eAudiobook").catch(() => [])
  ]);
  return [...ebooks, ...audiobooks];
}

async function lookupDigital(q) {
  const results = [];
  try { results.push(...await searchLibby(q)); } catch (_) {}
  try { results.push(...await searchHoopla(q)); } catch (_) {}
  const unique=[]; const keys=new Set();
  for (const r of results) {
    const k=`${r.provider}|${r.format}`;
    if (keys.has(k)) continue;
    keys.add(k); unique.push(r);
  }
  return unique;
}

function digitalToFormatRow(d) {
  return {
    format: `${d.provider} ${d.format}`,
    provider:d.provider,
    digital:true,
    statusText:d.statusText || "Found in collection",
    holds:Number.isFinite(d.holds) ? d.holds : null,
    available:Number.isFinite(d.available) ? d.available : null,
    total:Number.isFinite(d.total) ? d.total : null,
    always:!!d.always,
    url:d.url
  };
}
