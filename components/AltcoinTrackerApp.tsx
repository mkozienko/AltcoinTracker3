"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";

const LS_ROWS = "alt_rows_v1";
const LS_THEME = "alt_theme_v1";
const LS_XLSX_B64 = "alt_xlsx_b64";
const LS_USER_MAP = "alt_user_map_v1";

type Row = { token: string; buy: number; qty: number; spent?: number | null };
type PriceEntry = { price: number | null; ch: number | null; id: string };

function cx(...a:(string|false|undefined|null)[]){ return a.filter(Boolean).join(" "); }
function numOrNull(v:any){ const n = parseFloat(v); return Number.isFinite(n)? n : null; }
function fmt(n:number|null|undefined, d=2){ if(n==null || !Number.isFinite(n as number)) return "—"; return Number(n).toFixed(d); }
function colorPL(v:number|null){ if(v==null) return ""; return v>=0? "plpos":"plneg"; }
function normalizeSymbol(raw:string){ const up=(raw||"").toUpperCase().trim(); let s=up.replace(/[^A-Z0-9/]/g,"").replace(/USDT$|USD$|\/USDT$|\/USD$/,""); if(!s) s=up; return s; }

function useTheme(){
  const [theme,setTheme] = useState<string>(()=>localStorage.getItem(LS_THEME)||"light");
  useEffect(()=>{ document.documentElement.classList.toggle("dark", theme==="dark"); localStorage.setItem(LS_THEME, theme); },[theme]);
  return {theme,setTheme};
}
function useTradingViewScript(){
  useEffect(()=>{ const id="tv-script"; if(document.getElementById(id)) return; const s=document.createElement("script"); s.id=id; s.src="https://s3.tradingview.com/tv.js"; s.async=true; document.body.appendChild(s); },[]);
}

type MapDict = Record<string,string>;
async function loadBaseMap():Promise<MapDict>{ try{ const r=await fetch("/data/coingecko_map.json",{cache:"force-cache"}); if(!r.ok) return {}; return await r.json(); }catch{ return {}; } }
function loadUserMap():MapDict{ try{ const raw=localStorage.getItem(LS_USER_MAP); return raw? JSON.parse(raw):{}; }catch{ return {}; } }
function saveUserMap(m:MapDict){ localStorage.setItem(LS_USER_MAP, JSON.stringify(m)); }

async function geckoSearchId(symbol:string):Promise<string|null>{
  try{ const q=encodeURIComponent(symbol); const r=await fetch(`https://api.coingecko.com/api/v3/search?query=${q}`); if(!r.ok) return null; const js=await r.json(); const exact=js?.coins?.find((c:any)=>(c.symbol||"").toUpperCase()===symbol.toUpperCase()); return exact?.id||null; }catch{ return null; }
}

// === исправленный пакетный запрос ===
async function fetchPrices(symbols:string[], map:MapDict){
  const userMap = loadUserMap();
  const idMap:Record<string,string> = {};

  // Используем только сохранённые соответствия
  for(const sym of symbols){
    const fromUser=userMap[sym]; const fromBase=map[sym];
    if(fromUser) idMap[sym]=fromUser;
    else if(fromBase) idMap[sym]=fromBase;
  }

  const uniqueIds = Array.from(new Set(Object.values(idMap).filter(Boolean)));
  if(uniqueIds.length===0) return {} as Record<string,PriceEntry>;

  const chunkSize=150;
  const chunks:string[][]=[]; for(let i=0;i<uniqueIds.length;i+=chunkSize) chunks.push(uniqueIds.slice(i,i+chunkSize));
  const results:Record<string,PriceEntry>={};

  for(const ch of chunks){
    const url=`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ch.join(","))}&vs_currencies=usd&include_24hr_change=true`;
    const r=await fetch(url); if(!r.ok) continue; const js=await r.json();
    for(const [gid,obj] of Object.entries<any>(js)){
      const price=typeof obj?.usd==="number"? obj.usd:null;
      const chg=typeof obj?.usd_24h_change==="number"? obj.usd_24h_change:null;
      for(const [sym,mapped] of Object.entries(idMap)){ if(mapped===gid) results[sym]={price, ch:chg, id:gid}; }
    }
  }

  for(const sym of symbols)
    if(!results[sym])
      results[sym]={price:null, ch:null, id:idMap[sym]||"—"};

  return results;
}

async function readSummarySheet(file:File):Promise<Row[]>{
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  try{ const b64=btoa(String.fromCharCode(...new Uint8Array(data))); localStorage.setItem(LS_XLSX_B64,b64); }catch{}
  const wb=XLSX.read(data,{type:"array"}); const sheet=wb.Sheets["Summary"]||wb.Sheets[wb.SheetNames[0]];
  if(!sheet) throw new Error("Sheet 'Summary' not found");
  const rows:any[][]=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null});
  const out:Row[]=[];
  for(let i=1;i<rows.length;i++){ const r=rows[i]; if(!r) continue;
    const A=String(r[0]??"").trim(); if(!A) continue; const B=parseFloat(r[1]); const C=r[2]; const D=parseFloat(r[3]); const E=r[4];
    const spent=numOrNull(C)??numOrNull(E)??null; if(!Number.isFinite(B)) continue; out.push({token:A, buy:B, qty:Number.isFinite(D)?D:0, spent});
  }
  return out;
}

export default function AltcoinTrackerApp(){
  const {theme,setTheme}=useTheme();
  useTradingViewScript();

  const [rows,setRows]=useState<Row[]>(()=>{
    try{ const raw=localStorage.getItem(LS_ROWS); if(raw) return JSON.parse(raw);}catch{}
    return [{token:"ADA/USDT", buy:0.42, qty:100, spent:42},{token:"HFT( HFTUSDT )", buy:0.72, qty:200, spent:144}];
  });
  const [search,setSearch]=useState(""); const [profitOnly,setProfitOnly]=useState(false);
  const [sort,setSort]=useState<{key:string,dir:"asc"|"desc"}>({key:"token",dir:"asc"});
  const [prices,setPrices]=useState<Record<string,PriceEntry>>({}); const [map,setMap]=useState<MapDict>({});
  const [tvSymbol,setTvSymbol]=useState<string|null>(null); const tvRef=React.useRef<HTMLDivElement>(null);

  useEffect(()=>{ localStorage.setItem(LS_ROWS, JSON.stringify(rows)); },[rows]);
  useEffect(()=>{ (async()=> setMap(await loadBaseMap()))(); },[]);

  async function refresh(){
    const symbols=Array.from(new Set(rows.map(r=>normalizeSymbol(r.token))));
    const p=await fetchPrices(symbols,map);
    setPrices(p);
  }

  const table = useMemo(()=>{
    const enriched = rows.map(r=>{
      const sym=normalizeSymbol(r.token); const pe=prices[sym]; const cur=pe?.price ?? null;
      const buy=r.buy; const qty=r.qty; const spent=r.spent ?? buy*qty;
      const curVal=cur!=null?cur*qty:null; const pl=curVal!=null?curVal-spent:null; const plPct=cur!=null?((cur-buy)/buy)*100:null;
      const ch=pe?.ch ?? null; return {sym,row:r,cur,buy,qty,spent,curVal,pl,plPct,ch};
    });
    const q=search.trim().toUpperCase(); let list=enriched.filter(x=>!q||x.sym.includes(q)||x.row.token.toUpperCase().includes(q));
    if(profitOnly) list=list.filter(x=>(x.pl??-Infinity)>0);
    const getter=(x:any)=>{ switch(sort.key){ case "token": return x.sym; case "buy": return x.buy; case "cur": return x.cur??-Infinity; case "qty": return x.qty; case "spent": return x.spent; case "curVal": return x.curVal??-Infinity; case "pl": return x.pl??-Infinity; case "plPct": return x.plPct??-Infinity; default: return x.sym; } };
    list.sort((a,b)=>{ const av:any=getter(a), bv:any=getter(b); if(typeof av==="string"||typeof bv==="string"){ const c=String(av).localeCompare(String(bv)); return sort.dir==="asc"?c:-c; } const c=(av as number)-(bv as number); return sort.dir==="asc"?c:-c; });
    return list;
  },[rows,prices,search,profitOnly,sort]);

  async function onUploadXlsx(e:React.ChangeEvent<HTMLInputElement>){
    const f=e.target.files?.[0]; if(!f) return;
    try{
      const parsed=await readSummarySheet(f); setRows(parsed);
      const symbols=Array.from(new Set(parsed.map(r=>normalizeSymbol(r.token)))); const userMap=loadUserMap();
      for(const s of symbols){ if(userMap[s]) continue; const found=await geckoSearchId(s); if(found) userMap[s]=found; }
      saveUserMap(userMap);
      await refresh(); // 🔥 Автоматическое обновление после загрузки Excel
    }catch(err:any){ alert(err?.message||"Failed to read Excel"); } finally{ e.target.value=""; }
  }

  function onSort(key:string){ setSort(s=> s.key===key? {key, dir:s.dir==="asc"?"desc":"asc"} : {key, dir:"asc"}); }

  return (
    <div className="wrap">
      <header>
        <h1>Altcoin Tracker</h1>
        <div className="controls">
          <button className="btn" onClick={()=>setTheme(theme==="dark"?"light":"dark")}>{theme==="dark"?"🌞 Light":"🌙 Dark"}</button>
        </div>
      </header>

      <div className="controls" style={{marginBottom:8}}>
        <button className="btn primary" onClick={refresh}>Refresh prices</button>
        <label className="checkbox"><input type="checkbox" checked={profitOnly} onChange={e=>setProfitOnly(e.target.checked)} /> Profit only</label>
        <input type="text" placeholder="Search token..." value={search} onChange={e=>setSearch(e.target.value)} />
        <label className="btn" style={{position:"relative"}}>
          Upload Excel (Summary)
          <input type="file" accept=".xlsx,.xls" style={{position:"absolute",inset:0,opacity:0}} onChange={onUploadXlsx} />
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
            <tr key={idx} onClick={()=>setTvSymbol(t.sym+"USDT")} style={{cursor:"pointer"}}>
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
              <td className={cx("num", colorPL(t.plPct))}>{t.pl!=null? fmt(t.plPct,2)+"%":"—"}</td>
            </tr>
          ))}
          {table.length===0 && <tr><td className="muted" colSpan={9}>No rows. Upload Excel (Summary) or clear filters.</td></tr>}
        </tbody>
      </table>

      <footer>Click a row to open a TradingView chart (BINANCE: SYMBOLUSDT). Themes are synchronized.</footer>

      {tvSymbol && (
        <div className="modal" onClick={()=>setTvSymbol(null)}>
          <div className="modal-ctr" onClick={e=>e.stopPropagation()}>
            <div className="modal-h">
              <div style={{fontWeight:600}}>{tvSymbol} — TradingView</div>
              <button className="btn" onClick={()=>setTvSymbol(null)}>Close</button>
            </div>
            <div className="modal-b">
              <div id="tv_container" ref={tvRef} style={{width:"100%", height:"100%"}} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ label, sortKey, sort, onSort, right }:{ label:string; sortKey:string; sort:{key:string; dir:"asc"|"desc"}; onSort:(k:string)=>void; right?:boolean }){
  const is = sort.key===sortKey;
  return (
    <th className={cx(right && "num")}>
      <button className="btn" style={{padding:"4px 8px"}} onClick={()=>onSort(sortKey)}>
        {label} {is? (sort.dir==="asc"?"▾":"▴"):""}
      </button>
    </th>
  );
}
