"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";

const LS_ROWS = "alt_rows_v1";
const LS_THEME = "alt_theme_v1";
const LS_XLSX_B64 = "alt_xlsx_b64";
const LS_USER_MAP = "alt_user_map_v1";

type Row = { token: string; buy: number; qty: number; spent?: number | null };
type PriceEntry = { price: number | null; ch: number | null; id: string };
type MapDict = Record<string, string>;
type SortState = { key: string; dir: "asc" | "desc" };

function cx(...a: (string | false | undefined | null)[]) {
  return a.filter(Boolean).join(" ");
}
function numOrNull(v: any) {
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}
function fmt(n: number | null | undefined, d = 2) {
  if (n == null || !Number.isFinite(n as number)) return "—";
  return Number(n).toFixed(d);
}
function colorPL(v: number | null) {
  if (v == null) return "";
  return v >= 0 ? "plpos" : "plneg";
}

/* --------------------------------------------- */
/* SYMBOL NORMALIZATION */
/* --------------------------------------------- */
function normalizeSymbol(raw: string): string {
  if (!raw) return "";

  let s = raw.toUpperCase().trim();
  s = s.replace(/\(.*?\)/g, "");
  s = s.replace(/\s+/g, "");

  while (s.endsWith("USDT") || s.endsWith("USD")) {
    if (s.endsWith("USDT")) s = s.slice(0, -4);
    else if (s.endsWith("USD")) s = s.slice(0, -3);
  }

  s = s.replace(/[^A-Z0-9]/g, "");
  return s;
}

/* --------------------------------------------- */
/* THEME */
/* --------------------------------------------- */
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

/* --------------------------------------------- */
/* TRADINGVIEW LOADER */
/* --------------------------------------------- */
function useTradingViewScript() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const w = window as any;
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

/* --------------------------------------------- */
/* COINGECKO MAP */
/* --------------------------------------------- */
async function loadBaseMap(): Promise<MapDict> {
  try {
    const r = await fetch("/data/coingecko_map.json", { cache: "no-store" });
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

/* --------------------------------------------- */
/* COINGECKO SEARCH */
/* --------------------------------------------- */
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

/* --------------------------------------------- */
/* FETCH PRICES */
/* --------------------------------------------- */
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

  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
      uniqueIds.join(",")
    )}&vs_currencies=usd&include_24hr_change=true`;

  try {
    const r = await fetch(url);
    if (!r.ok) return results;

    const js = await r.json();

    for (const [sym, id] of Object.entries(symbolToId)) {
      const obj = js[id];
      results[sym] = {
        price: obj?.usd ?? null,
        ch: obj?.usd_24h_change ?? null,
        id,
      };
    }
  } catch {}

  return results;
}

/* --------------------------------------------- */
/* READ EXCEL */
/* --------------------------------------------- */
async function readSummarySheet(file: File): Promise<Row[]> {
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();

  const wb = XLSX.read(data, { type: "array" });
  const sheet = wb.Sheets["Summary"] || wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Sheet 'Summary' not found");

  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
  });

  const out: Row[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const token = String(r[0] ?? "").trim();
    if (!token) continue;

    const buy = numOrNull(r[1]);
    const qty = numOrNull(r[3]) ?? 0; // column D
    const spent = numOrNull(r[4]) ?? null; // column E

    if (buy == null) continue;
    out.push({ token, buy, qty, spent });
  }

  return out;
}

/* --------------------------------------------- */
/* MAIN COMPONENT */
/* --------------------------------------------- */
export default function AltcoinTrackerApp() {
  const { theme, setTheme } = useTheme();
  const tvReady = useTradingViewScript();
  const tvRef = useRef<HTMLDivElement | null>(null);

  const [rows, setRows] = useState<Row[]>([
    { token: "ADA/USDT", buy: 0.42, qty: 100, spent: 42 },
  ]);

  const [search, setSearch] = useState("");
  const [profitOnly, setProfitOnly] = useState(false);
  const [sort, setSort] = useState<SortState>({
    key: "token",
    dir: "asc",
  });
  const [prices, setPrices] = useState<Record<string, PriceEntry>>({});
  const [map, setMap] = useState<MapDict>({});
  const [tvSymbol, setTvSymbol] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const m = await loadBaseMap();
      setMap(m);
    })();
  }, []);

  useEffect(() => {
    if (Object.keys(map).length > 0) refresh();
  }, [map]);

  async function refresh() {
    const symbols = Array.from(
      new Set(rows.map((r) => normalizeSymbol(r.token)))
    );
    const p = await fetchPrices(symbols, map);
    setPrices(p);
  }

  function onSort(key: string) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  }

  const table = useMemo(() => {
    const enriched = rows.map((r) => {
      const sym = normalizeSymbol(r.token);
      const pe = prices[sym];
      const cur = pe?.price ?? null;
      const spent = r.spent ?? r.buy * r.qty;
      const curVal = cur != null ? cur * r.qty : null;
      const pl = curVal != null ? curVal - spent : null;
      const plPct = cur != null ? ((cur - r.buy) / r.buy) * 100 : null;

      return { sym, r, cur, spent, curVal, pl, plPct, ch: pe?.ch };
    });

    return enriched;
  }, [rows, prices]);

  /* TradingView widget */
  useEffect(() => {
    if (!tvSymbol || !tvReady || !tvRef.current) return;
    const w = window as any;
    if (!w.TradingView?.widget) return;

    tvRef.current.innerHTML = "";

    new w.TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: "60",
      theme: theme === "dark" ? "dark" : "light",
      container_id: "tv_chart_container",
    });
  }, [tvSymbol, tvReady, theme]);

  return (
    <div>
      <button onClick={refresh}>Refresh prices</button>

      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Buy</th>
            <th>Current</th>
            <th>Qty</th>
            <th>P/L</th>
          </tr>
        </thead>
        <tbody>
          {table.map((t, i) => (
            <tr
              key={i}
              onClick={() => setTvSymbol(`BINANCE:${t.sym}USDT`)}
            >
              <td>{t.sym}</td>
              <td>{fmt(t.r.buy)}</td>
              <td>{fmt(t.cur)}</td>
              <td>{fmt(t.r.qty)}</td>
              <td>{fmt(t.pl)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {tvSymbol && (
        <div style={{ height: 500 }}>
          <div id="tv_chart_container" ref={tvRef} />
        </div>
      )}
    </div>
  );
}
