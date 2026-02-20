"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";

const LS_ROWS = "alt_rows_v1";
const LS_THEME = "alt_theme_v1";
const LS_XLSX_B64 = "alt_xlsx_b64";
const LS_USER_MAP = "alt_user_map_v1";

type Row = { token: string; buy: number; qty: number; spent?: number | null };
type PriceEntry = { price: number | null; ch: number | null; id: string };

function cx(...a:(string|false|undefined|null)[]){ return a.filter(Boolean).join(" "); }

function numOrNull(v:any){
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g,"").trim());
  return Number.isFinite(n) ? n : null;
}
function fmt(n:number|null|undefined, d=2){ if(n==null || !Number.isFinite(n as number)) return "—"; return Number(n).toFixed(d); }
function colorPL(v:number|null){ if(v==null) return ""; return v>=0? "plpos":"plneg"; }

/* ---------------------------------------------
   SYMBOL NORMALIZATION
---------------------------------------------- */
function normalizeSymbol(raw: string): string {
  if (!raw) return "";

  let s = raw.toUpperCase().trim();

  s = s.replace(/\(.*?\)/g, ""); // убрать содержимое скобок
  s = s.replace(/\s+/g, "");     // убрать пробелы

  while (s.endsWith("USDT") || s.endsWith("USD")) {
    if (s.endsWith("USDT")) s = s.slice(0, -4);
    else if (s.endsWith("USD")) s = s.slice(0, -3);
  }

  s = s.replace(/[^A-Z0-9]/g, ""); // убрать мусор

  return s;
}

/* ---------------------------------------------
   THEME + TRADINGVIEW
---------------------------------------------- */

function useTheme(){
  const [theme,setTheme] = useState<string>(() => {
    if (typeof window === "undefined") return "light";
    return localStorage.getItem(LS_THEME) || "light";
  });

  useEffect(()=>{ 
    document.documentElement.classList.toggle("dark", theme==="dark"); 
    localStorage.setItem(LS_THEME, theme); 
  },[theme]);

  return {theme,setTheme};
}
function useTradingViewScript(){
  const [ready,setReady] = useState(false);

  useEffect(()=>{
    const w:any = window as any;
    if (w.TradingView) { setReady(true); return; }

    const id="tv-script";
    const existing = document.getElementById(id) as HTMLScriptElement | null;

    const onReady = () => setReady(true);

    if(existing){
      existing.addEventListener("load", onReady);
      return ()=>existing.removeEventListener("load", onReady);
    }

    const s=document.createElement("script");
    s.id=id;
    s.src="https://s3.tradingview.com/tv.js";
    s.async=true;
    s.onload = onReady;
    document.body.appendChild(s);
  },[]);

  return ready;
}


/* ---------------------------------------------
   MAP LOADERS
---------------------------------------------- */
type MapDict = Record<string,string>;

async function loadBaseMap():Promise<MapDict>{ 
  try{ 
    const r=await fetch("/data/coingecko_map.json",{cache:"force-cache"}); 
    if(!r.ok) return {}; 
    return await r.json(); 
  }catch{ return {}; } 
}

function loadUserMap():MapDict{ 
  try{ const raw=localStorage.getItem(LS_USER_MAP); return raw? JSON.parse(raw):{}; }catch{ return {}; } 
}
function saveUserMap(m:MapDict){ 
  localStorage.setItem(LS_USER_MAP, JSON.stringify(m)); 
}

/* ---------------------------------------------
   COINGECKO SEARCH API
---------------------------------------------- */
async function geckoSearchId(symbol:string):Promise<string|null>{
  try{ 
    const q=encodeURIComponent(symbol); 
    const r=await fetch(`https://api.coingecko.com/api/v3/search?query=${q}`);
    if(!r.ok) return null;

    const js=await r.json();
    const exact=js?.coins?.find((c:any)=>(c.symbol||"").toUpperCase()===symbol.toUpperCase());
    return exact?.id||null; 
  }catch{ 
    return null; 
  }
}

/* ---------------------------------------------
   PRICE FETCHER
---------------------------------------------- */
async function fetchPrices(symbols: string[], baseMap: MapDict) {
  const results: Record<string, PriceEntry> = {};
  const userMap = loadUserMap();

  const symbolToId: Record<string, string> = {};

  for (const sym of symbols) {
    if (!sym) continue;

    if (userMap[sym]) {
      symbolToId[sym] = userMap[sym];
      continue;
    }

    if (baseMap[sym]) {
      symbolToId[sym] = baseMap[sym];
      continue;
    }

    const found = await geckoSearchId(sym);
    if (found) {
      symbolToId[sym] = found;
      userMap[sym] = found;
    }
  }

  saveUserMap(userMap);

  const uniqueIds = Array.from(new Set(Object.values(symbolToId)));
  if (uniqueIds.length === 0) return results;

  const chunkSize = 170;
  let geckoSuccess = false;
  const geckoReturns: Record<string, PriceEntry> = {};

  try {
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      const url =
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(chunk.join(","))}` +
        `&vs_currencies=usd&include_24hr_change=true`;

      const r = await fetch(url);
      if (!r.ok) throw new Error("Gecko failed");
      const js = await r.json();
      geckoSuccess = true;

      for (const [gid, obj] of Object.entries<any>(js)) {
        const price = typeof obj?.usd === "number" ? obj.usd : null;
        const ch = typeof obj?.usd_24h_change === "number" ? obj.usd_24h_change : null;

        for (const [sym, mapped] of Object.entries(symbolToId)) {
          if (mapped === gid) {
            geckoReturns[sym] = { price, ch, id: gid };
          }
        }
      }
    }
  } catch {
    geckoSuccess = false;
  }

  if (geckoSuccess) {
    for (const s of symbols) {
      results[s] = geckoReturns[s] ?? { price: null, ch: null, id: symbolToId[s] || "—" };
    }
    return results;
  }

  return results;
}

/* ---------------------------------------------
   READ EXCEL SUMMARY
---------------------------------------------- */
async function readSummarySheet(file:File):Promise<Row[]>{
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  try{ 
    const b64 = btoa(String.fromCharCode(...new Uint8Array(data))); 
    localStorage.setItem(LS_XLSX_B64,b64); 
  }catch{}

  const wb = XLSX.read(data,{type:"array"}); 
  const sheet = wb.Sheets["Summary"] || wb.Sheets[wb.SheetNames[0]];
  if(!sheet) throw new Error("Sheet 'Summary' not found");

  const rows:any[][] = XLSX.utils.sheet_to_json(sheet,{header:1,defval:null});
  const out:Row[] = [];

  for(let i=1;i<rows.length;i++){ 
    const r=rows[i]; 
    if(!r) continue;

    const token = String(r[0] ?? "").trim(); 
    if(!token) continue;

    const buy = numOrNull(r[1]);
    if (buy == null) continue;
    const qty = numOrNull(r[3]) ?? 0;        // ✅ column D
    const spent = numOrNull(r[4]) ?? null;   // ✅ column E (если есть)

    out.push({token, buy, qty, spent});
  }

  return out;
}

/* ---------------------------------------------
   MAIN COMPONENT
---------------------------------------------- */

export default function AltcoinTrackerApp(){
  const {theme,setTheme} = useTheme(); 

  const tvReady = useTradingViewScript();
  const tvRef = useRef<HTMLDivElement|null>(null);

  const [rows,setRows] = useState<Row[]>(()=>{
    try{ 
      const raw=localStorage.getItem(LS_ROWS); 
      if(raw) return JSON.parse(raw);
    }catch{}
    return [{token:"ADA/USDT", buy:0.42, qty:100, spent:42}];
  });

  const [search,setSearch] = useState("");
  const [profitOnly,setProfitOnly] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({key: "token", dir: "asc",});
  const [prices,setPrices] = useState<Record<string,PriceEntry>>({});
  const [map,setMap] = useState<MapDict>({});
  const [tvSymbol,setTvSymbol] = useState<string|null>(null);

useEffect(()=>{
  if(!tvSymbol || !tvReady || !tvRef.current) return;

  const w:any = window as any;
  if(!w.TradingView?.widget) return;

  tvRef.current.innerHTML = "";

  new w.TradingView.widget({
    autosize: true,
    symbol: tvSymbol,
    interval: "60",
    timezone: "Etc/UTC",
    theme: theme==="dark" ? "dark" : "light",
    style: "1",
    locale: "en",
    enable_publishing: false,
    allow_symbol_change: true,
    container_id: "tv_chart_container",
  });

},[tvSymbol,tvReady,theme]);

  /* SAVE ROWS */
  useEffect(()=>{ 
    localStorage.setItem(LS_ROWS, JSON.stringify(rows)); 
  },[rows]);

  /* LOAD BASEMAP */
  useEffect(() => {
    (async () => {
      const m = await loadBaseMap();
      console.log("MAP LOADED:", m);
      setMap(m);
    })();
  }, []);

  /* AUTO REFRESH AFTER MAP LOADED */


useEffect(() => {
  if (Object.keys(map).length === 0) return;
  refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [rows, map]);


  /* REFRESH FUNCTION */
  async function refresh(){
    console.log("REFRESH() STARTED");

    if (!map || Object.keys(map).length === 0) {
      console.warn("Map not loaded — skipping refresh");
      return;
    }

    const symbols = Array.from(new Set(rows.map(r=>normalizeSymbol(r.token))));
    console.log("Symbols:", symbols);

    const p = await fetchPrices(symbols,map);
    setPrices(p);
  }

  /* UPLOAD EXCEL */
  async function onUploadXlsx(e:React.ChangeEvent<HTMLInputElement>){
    const f=e.target.files?.[0]; 
    if(!f) return;

    try{
      const parsed=await readSummarySheet(f); 
      setRows(parsed);

      const symbols = Array.from(new Set(parsed.map(
        r=>normalizeSymbol(r.token)
      )));

      const userMap = loadUserMap();

      for(const s of symbols){ 
        if(userMap[s]) continue;
        const found = await geckoSearchId(s);
        if(found) userMap[s] = found;
      }
      saveUserMap(userMap);

      // ❗ refresh НЕ вызываем здесь!
    }
    catch(err:any){ 
      alert(err?.message || "Failed to read Excel"); 
    } 
    finally{ 
      e.target.value = ""; 
    }
  }

  /* TABLE */
  const table = useMemo(()=>{
    const enriched = rows.map(r=>{
      const sym=normalizeSymbol(r.token); 
      const pe=prices[sym]; 
      const cur=pe?.price ?? null;
      const buy=r.buy; 
      const qty=r.qty; 
      const spent=r.spent ?? buy*qty;
      const curVal=cur!=null?cur*qty:null; 
      const pl=curVal!=null?curVal-spent:null; 
      const plPct=cur!=null?((cur-buy)/buy)*100:null;
      const ch=pe?.ch ?? null;

      return {sym,row:r,cur,buy,qty,spent,curVal,pl,plPct,ch};
    });


    const q = search.trim().toUpperCase();
    let list = enriched.filter(x =>
      !q || x.sym.includes(q) || x.row.token.toUpperCase().includes(q)
    );

    if(profitOnly) list = list.filter(x => (x.pl ?? -Infinity) > 0);

    const getter=(x:any)=>{
      switch(sort.key){
        case "token": return x.sym;
        case "buy": return x.buy;
        case "cur": return x.cur??-Infinity;
        case "qty": return x.qty;
        case "spent": return x.spent;
        case "curVal": return x.curVal??-Infinity;
        case "pl": return x.pl??-Infinity;
        case "plPct": return x.plPct??-Infinity;
        default: return x.sym;
      }
    };

    list.sort((a,b)=>{
      const av:any=getter(a), bv:any=getter(b);
      if(typeof av==="string"||typeof bv==="string"){
        const c=String(av).localeCompare(String(bv)); 
        return sort.dir==="asc"?c:-c;
      }
      const c=(av as number)-(bv as number); 
      return sort.dir==="asc"?c:-c;
    });

    return list;
  },[rows,prices,search,profitOnly,sort]);

  /* RENDER */
  function onSort(key:string){
    setSort(s=> s.key===key
      ? {key, dir:s.dir==="asc"?"desc":"asc"}
      : {key, dir:"asc"});
  }

  return (
    <div className="wrap">
      <header>
        <h1>Altcoin Tracker</h1>
        <div className="controls">
          <button className="btn" onClick={()=>setTheme(theme==="dark"?"light":"dark")}>
            {theme==="dark"?"🌞 Light":"🌙 Dark"}
          </button>
        </div>
      </header>

      <div className="controls" style={{marginBottom:8}}>
        <button className="btn primary" onClick={refresh}>Refresh prices</button>
        <label className="checkbox">
          <input type="checkbox" 
            checked={profitOnly} 
            onChange={e=>setProfitOnly(e.target.checked)} 
          /> Profit only
        </label>

        <input type="text" 
          placeholder="Search token..." 
          value={search} 
          onChange={e=>setSearch(e.target.value)} />

        <label className="btn" style={{position:"relative"}}>
          Upload Excel (Summary)
          <input type="file" accept=".xlsx,.xls" 
            style={{position:"absolute",inset:0,opacity:0}} 
            onChange={onUploadXlsx} 
          />
        </label>
      </div>

      <table>
        <thead>
          <tr>
            <Th label="Token" sortKey="token" sort={sort} onSort={onSort} />
            <Th label="Buy Price (USD)" sortKey="buy" sort={sort} onSort={onSort} right />
            <Th label="Current (USD)" sortKey="cur" sort={sort} onSort={onSort} right />
            <th className="num">24h %</th>
            <Th label="Qty" sortKey="qty" sort={sort} onSort={onSort} right />
            <Th label="Spent" sortKey="spent" sort={sort} onSort={onSort} right />
            <Th label="Current Value" sortKey="curVal" sort={sort} onSort={onSort} right />
            <Th label="P/L $" sortKey="pl" sort={sort} onSort={onSort} right />
            <Th label="P/L %" sortKey="plPct" sort={sort} onSort={onSort} right />
          </tr>
        </thead>

        <tbody>
          {table.map((t, idx)=>(
            <tr key={idx} onClick={()=>setTvSymbol(`BINANCE:${t.sym}USDT`)} style={{cursor:"pointer"}}>
              <td>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span>{t.sym}</span>
                  <span className="muted">({t.row.token})</span>
                  {t.cur==null && <span className="muted">— not found on CoinGecko</span>}
                </div>
              </td>
              <td className="num">{fmt(t.buy,6)}</td>
              <td className="num">{fmt(t.cur,6)}</td>
              <td className="num">{fmt(t.ch,2)}</td>
              <td className="num">{fmt(t.qty,4)}</td>
              <td className="num">{fmt(t.spent,2)}</td>
              <td className="num">{fmt(t.curVal,2)}</td>
              <td className={cx("num", colorPL(t.pl))}>{fmt(t.pl,2)}</td>
              <td className={cx("num", colorPL(t.plPct))}>
                {t.pl!=null? fmt(t.plPct,2)+"%":"—"}
              </td>
            </tr>
          ))}

          {table.length===0 && (
            <tr>
              <td className="muted" colSpan={9}>
                No rows. Upload Excel (Summary) or clear filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>

{tvSymbol && (
  <div style={{marginTop:12}}>
    <div className="controls" style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
      <div className="muted">Chart: {tvSymbol}</div>
      <button className="btn" onClick={()=>setTvSymbol(null)}>Close chart</button>
    </div>

    <div style={{height:520}}>
      <div id="tv_chart_container" ref={tvRef} style={{width:"100%",height:"100%"}} />
    </div>
  </div>
)}





      <footer>
        Click a row to open a TradingView chart (BINANCE: SYMBOLUSDT). Themes are synchronized.
      </footer>
    </div>
  );
}

function Th({ label, sortKey, sort, onSort, right }:
  { label:string; sortKey:string; sort:{key:string; dir:"asc"|"desc"}; onSort:(k:string)=>void; right?:boolean }){
  
  const is = sort.key===sortKey;

  return (
    <th className={cx(right && "num")}>
      <button className="btn" 
        style={{padding:"4px 8px"}} 
        onClick={()=>onSort(sortKey)}>
        {label} {is? (sort.dir==="asc"?"▾":"▴"):""}
      </button>
    </th>
  );
}
