"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const LS_ROWS = "alt_rows_v1";
const LS_THEME = "alt_theme_v1";
const LS_XLSX_B64 = "alt_xlsx_b64";
const LS_USER_MAP = "alt_user_map_v1";

type Row = { token: string; buy: number; qty: number; spent?: number | null };
type PriceEntry = { price: number | null; ch: number | null; id: string };
type MapDict = Record<string, string>;

function cx(...a: (string | false | undefined | null)[]) {
  return a.filter(Boolean).join(" ");
}

function numOrNull(v: any) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// поддержка простых формул типа "=0.1+0.2" или "=(1+2)*3"
function numOrNullMaybeFormula(v: any) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  const s = String(v).trim();
  // обычное число строкой
  const n = numOrNull(s);
  if (n != null) return n;

  // простая формула (НЕ Excel-функции типа SUMIF)
  if (s.startsWith("=")) {
    const expr = s.slice(1).trim();
    // разрешим только цифры, пробелы и арифметику
    if (/^[0-9+\-*/().\s]+$/.test(expr)) {
      try {
        // eslint-disable-next-line no-new-func
        const val = Function(`"use strict"; return (${expr});`)();
        const nn = typeof val === "number" ? val : parseFloat(String(val));
        return Number.isFinite(nn) ? nn : null;
      } catch {
        return null;
      }
    }
  }

  return null;
}

function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n as number)) return "—";
  return Number(n).toFixed(d);
}
function colorPL(v: number | null) {
  if (v == null) return "";
  return v >= 0 ? "plpos" : "plneg";
}

/* ---------------------------------------------
   SYMBOL NORMALIZATION
---------------------------------------------- */
function normalizeSymbol(raw: string): string {
  if (!raw) return "";
  let s = raw.toUpperCase().trim();
  s = s.replace(/\(.*?\)/g, "");
  s = s.replace(/\s+/g, "");

  // ВАЖНО: сначала убрать все разделители (/, -, :)
  s = s.replace(/[^A-Z0-9]/g, "");

  // потом корректно отрезать хвосты USDT/USD
  while (s.endsWith("USDT") || s.endsWith("USD")) {
    if (s.endsWith("USDT")) s = s.slice(0, -4);
    else s = s.slice(0, -3);
  }
  return s;
}

/* ---------------------------------------------
   THEME + TRADINGVIEW
---------------------------------------------- */
function useTheme() {
  const [theme, setTheme] = useState<string>(() => {
    if (typeof window === "undefined") return "light";
    return localStorage.getItem(LS_THEME) || "light";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);

  return { theme, setTheme };
}

function useTradingViewScript() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const w: any = window as any;
    if (w.TradingView) {
      setReady(true);
      return;
    }

    const id = "tv-script";
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    const onReady = () => setReady(true);

    if (existing) {
      existing.addEventListener("load", onReady);
      return () => existing.removeEventListener("load", onReady);
    }

    const s = document.createElement("script");
    s.id = id;
    s.src = "https://s3.tradingview.com/tv.js";
    s.async = true;
    s.onload = onReady;
    document.body.appendChild(s);
  }, []);

  return ready;
}

/* ---------------------------------------------
   MAP LOADERS
---------------------------------------------- */
async function loadBaseMap(): Promise<MapDict> {
  try {
    const r = await fetch("/data/coingecko_map.json", { cache: "force-cache" });
    if (!r.ok) return {};
    return await r.json();
  } catch {
    return {};
  }
}

function loadUserMap(): MapDict {
  try {
    const raw = localStorage.getItem(LS_USER_MAP);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveUserMap(m: MapDict) {
  localStorage.setItem(LS_USER_MAP, JSON.stringify(m));
}

/* ---------------------------------------------
   COINGECKO SEARCH API
---------------------------------------------- */
async function geckoSearchId(symbol: string): Promise<string | null> {
  try {
    const q = encodeURIComponent(symbol);
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${q}`);
    if (!r.ok) return null;

    const js = await r.json();
    const exact = js?.coins?.find(
      (c: any) => (c.symbol || "").toUpperCase() === symbol.toUpperCase()
    );
    return exact?.id || null;
  } catch {
    return null;
  }
}


async function fetchPricesCryptoCompare(symbols: string[]) {
  const out: Record<string, PriceEntry> = {};
  const clean = Array.from(new Set(symbols.filter(Boolean)));
  if (clean.length === 0) return out;

  const chunkSize = 200; // чтобы URL не был огромным
  for (let i = 0; i < clean.length; i += chunkSize) {
    const chunk = clean.slice(i, i + chunkSize);
    const fsyms = chunk.join(",");

    try {
      const r = await fetch(
        `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${encodeURIComponent(
          fsyms
        )}&tsyms=USD`,
        { cache: "no-store" }
      );
      if (!r.ok) continue;

      const js = await r.json();

      for (const s of chunk) {
        const price = js?.RAW?.[s]?.USD?.PRICE;
        const ch = js?.RAW?.[s]?.USD?.CHANGEPCT24HOUR;

        out[s] = {
          price: typeof price === "number" ? price : null,
          ch: typeof ch === "number" ? ch : null,
          id: "cryptocompare",
        };
      }
    } catch {
      // ignore
    }
  }

  return out;
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
  const geckoReturns: Record<string, PriceEntry> = {};

  try {
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);

      const url =
  `/api/coingecko/simple-price?ids=${encodeURIComponent(chunk.join(","))}` +
  `&vs_currencies=usd&include_24hr_change=true`;


      const r = await fetch(url);
      if (!r.ok) throw new Error("Gecko failed");
      const js = await r.json();

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
    // если API упал — просто вернём пусто
  }

// Fallback for suspicious prices (0 / null / extremely small)
const badIds = new Set<string>();

for (const [sym, pe] of Object.entries(geckoReturns)) {
  const p = pe?.price;
  if (p == null || !Number.isFinite(p) || p <= 0 || p < 0.000001) {
    if (pe?.id && pe.id !== "—") badIds.add(pe.id);
  }
}

// If some ids have bad prices, re-fetch them via /coins/markets (more stable)


if (badIds.size > 0) {
  const ids = Array.from(badIds);
  const chunkSize2 = 100;

  for (let i = 0; i < ids.length; i += chunkSize2) {
    const chunk = ids.slice(i, i + chunkSize2);

const url =
  `/api/coingecko/markets?vs_currency=usd&ids=${encodeURIComponent(chunk.join(","))}` +
  `&price_change_percentage=24h`;
   

    try {
      const r2 = await fetch(url);
      if (!r2.ok) continue;
      const arr = await r2.json();

      // arr: [{ id, current_price, price_change_percentage_24h, ... }]
      for (const it of arr) {
        const gid = String(it?.id || "");
        const price = typeof it?.current_price === "number" ? it.current_price : null;
        const ch =
          typeof it?.price_change_percentage_24h === "number"
            ? it.price_change_percentage_24h
            : null;

        // update all symbols mapped to this gid
        for (const [sym, mapped] of Object.entries(symbolToId)) {
          if (mapped === gid) {
            geckoReturns[sym] = { price, ch, id: gid };
          }
        }
      }
    } catch {
      // ignore fallback errors
    }
  }
}

// FINAL fallback: CryptoCompare for still-missing/suspicious prices
const needCC: string[] = [];

for (const s of symbols) {
  const p = geckoReturns[s]?.price ?? null;
  if (p == null || !Number.isFinite(p) || p <= 0 || p < 0.000001) {
    needCC.push(s);
  }
}

if (needCC.length > 0) {
  const cc = await fetchPricesCryptoCompare(needCC);

  for (const s of needCC) {
    const price = cc[s]?.price ?? null;
    const ch = cc[s]?.ch ?? null;

    if (price != null && Number.isFinite(price) && price > 0) {
      geckoReturns[s] = {
        price,
        ch: ch ?? geckoReturns[s]?.ch ?? null,
        id: geckoReturns[s]?.id || "—",
      };
    }
  }
}
	
  for (const s of symbols) {
    results[s] = geckoReturns[s] ?? { price: null, ch: null, id: symbolToId[s] || "—" };
  }

  return results;
}

/* ---------------------------------------------
   READ EXCEL (Summary with fallback to Buys)
---------------------------------------------- */
function normalizeTokenForRow(token: string) {
  const t = String(token || "").trim();
  if (!t) return "";
  // если уже есть "/", не трогаем; иначе добавим "/USDT" (как было у тебя)
  return t.includes("/") ? t : `${t}/USDT`;
}

function readFromSummary(XLSX: any, wb: any): Row[] | null {
  const sheet = wb.Sheets["Summary"] || wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return null;

  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const out: Row[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const tokenRaw = String(r[0] ?? "").trim();
    if (!tokenRaw) continue;

    const buy = numOrNullMaybeFormula(r[1]);
    if (buy == null) continue;

    const qty = numOrNullMaybeFormula(r[3]); // D
    const spent = numOrNullMaybeFormula(r[4]); // E

    out.push({
      token: normalizeTokenForRow(tokenRaw),
      buy,
      qty: qty ?? 0,
      spent: spent ?? null,
    });
  }

  // если почти всё qty = 0, значит Summary не даёт чисел (формулы без cached results)
  const nonEmpty = out.filter((x) => x.token).length;
  const nonZeroQty = out.filter((x) => (x.qty ?? 0) > 0).length;

  if (nonEmpty > 0 && nonZeroQty === 0) return null; // fallback на Buys
  return out;
}

function readFromBuys(XLSX: any, wb: any): Row[] {
  const sheet = wb.Sheets["Buys"];
  if (!sheet) throw new Error("Sheet 'Buys' not found");

  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // агрегируем по символу (BTC, SOL, ...)
  const agg: Record<
    string,
    { tokenRaw: string; qty: number; spent: number }
  > = {};

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const tokenRaw = String(r[0] ?? "").trim();
    if (!tokenRaw) continue;

    const price = numOrNullMaybeFormula(r[1]);
    const qty = numOrNullMaybeFormula(r[3]);

    if (price == null) continue;
    if (qty == null || qty === 0) continue;

    const spent = price * qty;

    const key = normalizeSymbol(tokenRaw); // BTC, SOL, ...
    if (!key) continue;

    if (!agg[key]) agg[key] = { tokenRaw, qty: 0, spent: 0 };
    agg[key].qty += qty;
    agg[key].spent += spent;
  }

  const out: Row[] = Object.entries(agg)
    .filter(([, v]) => v.qty > 0)
    .map(([, v]) => {
      const buy = v.spent / v.qty; // weighted avg
      return {
        token: normalizeTokenForRow(v.tokenRaw),
        buy,
        qty: v.qty,
        spent: v.spent,
      };
    });

  return out;
}

async function readSummarySheet(file: File): Promise<Row[]> {
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();

  try {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(data)));
    localStorage.setItem(LS_XLSX_B64, b64);
  } catch {}

  const wb = XLSX.read(data, { type: "array" });

  // 1) пробуем Summary (как раньше)
  const fromSummary = readFromSummary(XLSX, wb);
  if (fromSummary && fromSummary.length > 0) return fromSummary;

  // 2) fallback: Buys (надёжно, потому что qty там числа)
  return readFromBuys(XLSX, wb);
}

/* ---------------------------------------------
   MAIN COMPONENT
---------------------------------------------- */
export default function AltcoinTrackerApp() {
  const { theme, setTheme } = useTheme();

  const tvReady = useTradingViewScript();
  const tvRef = useRef<HTMLDivElement | null>(null);

  const [rows, setRows] = useState<Row[]>(() => {
    try {
      const raw = localStorage.getItem(LS_ROWS);
      if (raw) return JSON.parse(raw);
    } catch {}
    return [{ token: "ADA/USDT", buy: 0.42, qty: 100, spent: 42 }];
  });

  const [search, setSearch] = useState("");
  const [profitOnly, setProfitOnly] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({
    key: "token",
    dir: "asc",
  });
  const [prices, setPrices] = useState<Record<string, PriceEntry>>({});
  const [map, setMap] = useState<MapDict>({});
  const [tvSymbol, setTvSymbol] = useState<string | null>(null);

  /* TradingView widget */
  useEffect(() => {
    if (!tvSymbol || !tvReady || !tvRef.current) return;

    const w: any = window as any;
    if (!w.TradingView?.widget) return;

    tvRef.current.innerHTML = "";

    new w.TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: "60",
      timezone: "Etc/UTC",
      theme: theme === "dark" ? "dark" : "light",
      style: "1",
      locale: "en",
      enable_publishing: false,
      allow_symbol_change: true,
      container_id: "tv_chart_container",
    });
  }, [tvSymbol, tvReady, theme]);

  /* SAVE ROWS */
  useEffect(() => {
    localStorage.setItem(LS_ROWS, JSON.stringify(rows));
  }, [rows]);

  /* LOAD BASEMAP */
  useEffect(() => {
    (async () => {
      const m = await loadBaseMap();
      setMap(m);
    })();
  }, []);

useEffect(() => {
  if (!tvSymbol) return;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setTvSymbol(null);
  };

  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [tvSymbol]);

  /* ONE refresh effect: when map ready OR rows changed */
  useEffect(() => {
    if (Object.keys(map).length === 0) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, map]);

useEffect(() => {
  if (!tvSymbol) return;

  const prev = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  return () => {
    document.body.style.overflow = prev;
  };
}, [tvSymbol]);

  async function refresh() {
    if (!map || Object.keys(map).length === 0) return;
    const symbols = Array.from(new Set(rows.map((r) => normalizeSymbol(r.token))));
    const p = await fetchPrices(symbols, map);
    setPrices(p);
  }

  /* UPLOAD EXCEL */
  async function onUploadXlsx(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const parsed = await readSummarySheet(f);
      setRows(parsed);

      // поддержка userMap (как у тебя было)
      const symbols = Array.from(new Set(parsed.map((r) => normalizeSymbol(r.token))));
      const userMap = loadUserMap();

      for (const s of symbols) {
        if (userMap[s]) continue;
        const found = await geckoSearchId(s);
        if (found) userMap[s] = found;
      }
      saveUserMap(userMap);

      // НЕ вызываем refresh() тут — его вызовет useEffect([rows,map])
    } catch (err: any) {
      alert(err?.message || "Failed to read Excel");
    } finally {
      e.target.value = "";
    }
  }

  const table = useMemo(() => {
    const enriched = rows.map((r) => {
      const sym = normalizeSymbol(r.token);
      const pe = prices[sym];
      const cur = pe?.price ?? null;
      const buy = r.buy;
      const qty = r.qty;
      const spent = r.spent ?? buy * qty;
      const curVal = cur != null ? cur * qty : null;
      const pl = curVal != null ? curVal - spent : null;
      const plPct = cur != null ? ((cur - buy) / buy) * 100 : null;
      const ch = pe?.ch ?? null;

      return { sym, row: r, cur, buy, qty, spent, curVal, pl, plPct, ch };
    });



const totals = useMemo(() => {
  let totalSpent = 0;
  let totalCur = 0;
  let pricedCount = 0;

  for (const t of table) {
    totalSpent += t.spent ?? 0;

    if (t.cur != null && Number.isFinite(t.cur)) {
      totalCur += t.cur * (t.qty ?? 0);
      pricedCount += 1;
    }
  }

  const totalPL = totalCur - totalSpent;
  const totalPLPct = totalSpent > 0 ? (totalPL / totalSpent) * 100 : null;

  return { totalSpent, totalCur, totalPL, totalPLPct, pricedCount };
}, [table]);

    const q = search.trim().toUpperCase();
    let list = enriched.filter(
      (x) => !q || x.sym.includes(q) || x.row.token.toUpperCase().includes(q)
    );

    if (profitOnly) list = list.filter((x) => (x.pl ?? -Infinity) > 0);

    const getter = (x: any) => {
      switch (sort.key) {
        case "token":
          return x.sym;
        case "buy":
          return x.buy;
        case "cur":
          return x.cur ?? -Infinity;
        case "qty":
          return x.qty;
        case "spent":
          return x.spent;
        case "curVal":
          return x.curVal ?? -Infinity;
        case "pl":
          return x.pl ?? -Infinity;
        case "plPct":
          return x.plPct ?? -Infinity;
        default:
          return x.sym;
      }
    };

    list.sort((a, b) => {
      const av: any = getter(a),
        bv: any = getter(b);
      if (typeof av === "string" || typeof bv === "string") {
        const c = String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? c : -c;
      }
      const c = (av as number) - (bv as number);
      return sort.dir === "asc" ? c : -c;
    });

    return list;
  }, [rows, prices, search, profitOnly, sort]);

  function onSort(key: string) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );
  }

  return (
    <div className="wrap">
      <header>
        <h1>Altcoin Tracker</h1>
        <div className="controls">
          <button className="btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "🌞 Light" : "🌙 Dark"}
          </button>
        </div>
      </header>

      <div className="controls" style={{ marginBottom: 8 }}>
        <button className="btn primary" onClick={refresh}>
          Refresh prices
        </button>

        <label className="checkbox">
          <input checked={profitOnly} onChange={(e) => setProfitOnly(e.target.checked)} type="checkbox" />{" "}
          Profit only
        </label>

        <input
          type="text"
          placeholder="Search token..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <label className="btn" style={{ position: "relative" }}>
          Upload Excel (Summary)
          <input
            type="file"
            accept=".xlsx,.xls"
            style={{ position: "absolute", inset: 0, opacity: 0 }}
            onChange={onUploadXlsx}
          />
        </label>
      </div>

<div className="controls" style={{ marginBottom: 8 }}>
  <div className="muted">
    <b>Today total:</b> ${fmt(totals.totalCur, 2)}{" "}
    <span className={cx(colorPL(totals.totalPL))}>
      ({totals.totalPL >= 0 ? "+" : ""}{fmt(totals.totalPL, 2)}
      {totals.totalPLPct != null ? `, ${fmt(totals.totalPLPct, 2)}%` : ""})
    </span>
    {" "}• Spent: ${fmt(totals.totalSpent, 2)} • Priced coins: {totals.pricedCount}/{table.length}
  </div>
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
          {table.map((t, idx) => (
            <tr key={idx} onClick={() => setTvSymbol(`BINANCE:${t.sym}USDT`)} style={{ cursor: "pointer" }}>
              <td>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span>{t.sym}</span>
                  <span className="muted">({t.row.token})</span>
                  {t.cur == null && (
                  <span className="muted">— no price returned from CoinGecko</span>
                  )}

                 {t.cur != null && t.cur > 0 && t.cur < 0.000001 && (
                 <span className="muted">— suspiciously low price</span>
                 )}       
		
                </div>
              </td>
              <td className="num">{fmt(t.buy, 6)}</td>
              <td className="num">{fmt(t.cur, 6)}</td>
              <td className="num">{fmt(t.ch, 2)}</td>
              <td className="num">{fmt(t.qty, 6)}</td>
              <td className="num">{fmt(t.spent, 2)}</td>
              <td className="num">{fmt(t.curVal, 2)}</td>
              <td className={cx("num", colorPL(t.pl))}>{fmt(t.pl, 2)}</td>
              <td className={cx("num", colorPL(t.plPct))}>{t.pl != null ? fmt(t.plPct, 2) + "%" : "—"}</td>
            </tr>
          ))}

          {table.length === 0 && (
            <tr>
              <td className="muted" colSpan={9}>
                No rows. Upload Excel (Summary) or clear filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>

{tvSymbol &&
  typeof document !== "undefined" &&
  createPortal(
    <div
      onClick={() => setTvSymbol(null)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 999999,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1100px, 100%)",
          height: "min(720px, 100%)",
          background: theme === "dark" ? "#111" : "#fff",
          borderRadius: 12,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          className="controls"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 12px",
            borderBottom: theme === "dark" ? "1px solid #222" : "1px solid #eee",
          }}
        >
          <div className="muted">Chart: {tvSymbol}</div>
          <button className="btn" onClick={() => setTvSymbol(null)}>
            Close
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          <div id="tv_chart_container" ref={tvRef} style={{ width: "100%", height: "100%" }} />
        </div>
      </div>
    </div>,
    document.body
  )}

      <footer>Click a row to open a TradingView chart (BINANCE: SYMBOLUSDT). Themes are synchronized.</footer>
    </div>
  );
}

function Th({
  label,
  sortKey,
  sort,
  onSort,
  right,
}: {
  label: string;
  sortKey: string;
  sort: { key: string; dir: "asc" | "desc" };
  onSort: (k: string) => void;
  right?: boolean;
}) {
  const is = sort.key === sortKey;

  return (
    <th className={cx(right && "num")}>
      <button className="btn" style={{ padding: "4px 8px" }} onClick={() => onSort(sortKey)}>
        {label} {is ? (sort.dir === "asc" ? "▾" : "▴") : ""}
      </button>
    </th>
  );
}
