"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  isValidPrice,
  normalizeSymbol,
  readPortfolioWorkbook,
  resolveCoinGeckoPrices,
  type PortfolioRow,
} from "../lib/portfolio.mjs";

const LS_ROWS = "alt_rows_v1";
const LS_THEME = "alt_theme_v1";
const LS_XLSX_B64 = "alt_xlsx_b64";
const LS_USER_MAP = "alt_user_map_v1";

type Row = PortfolioRow;
type PriceEntry = { price: number | null; ch: number | null; id: string };
type MapDict = Record<string, string>;

function cx(...a: (string | false | undefined | null)[]) {
  return a.filter(Boolean).join(" ");
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
    const r = await fetch(`/data/coingecko_map.json?v=5`, { cache: "no-store" });
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


/* ---------------------------------------------
   PRICE FETCHER
---------------------------------------------- */
async function fetchPrices(symbols: string[], baseMap: MapDict) {
  const userMap = loadUserMap();
  const resolved = await resolveCoinGeckoPrices({
    symbols,
    baseMap,
    userMap,
    searchId: geckoSearchId,
    requestJson: async (url: string) => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("CoinGecko request failed");
      return response.json();
    },
  });
  saveUserMap(resolved.userMap);
  return resolved.prices;
}

/* ---------------------------------------------
   READ EXCEL (Summary with fallback to Buys)
---------------------------------------------- */
async function readSummarySheet(file: File): Promise<Row[]> {
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();

  try {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(data)));
    localStorage.setItem(LS_XLSX_B64, b64);
  } catch {}

  return readPortfolioWorkbook(XLSX, XLSX.read(data, { type: "array" }));
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
  const [showTotals, setShowTotals] = useState(true);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({
    key: "token",
    dir: "asc",
  });
  const [prices, setPrices] = useState<Record<string, PriceEntry>>({});
  const [map, setMap] = useState<MapDict>({});
  const [tvSymbol, setTvSymbol] = useState<string | null>(null);

  const [compact, setCompact] = useState(false);
  const priceRequestRef = useRef(0);

useEffect(() => {
  const mq = window.matchMedia("(max-width: 768px)");
  setCompact(mq.matches); // только начальное значение
}, []);






  /* TradingView widget */
  useEffect(() => {
    if (!tvSymbol || !tvReady || !tvRef.current) return;

    const w: any = window as any;
    if (!w.TradingView?.widget) return;

    tvRef.current.innerHTML = "";

    new w.TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: "D",
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
    const requestId = ++priceRequestRef.current;
    const symbols = Array.from(new Set(rows.map((r) => normalizeSymbol(r.token))));
    const p = await fetchPrices(symbols, map);
    if (requestId === priceRequestRef.current) setPrices(p);
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
        if (map[s]) continue;
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


const totals = useMemo(() => {
  let totalSpent = 0;
  let totalCur = 0;
  let pricedCount = 0;

  for (const t of table) {
    totalSpent += t.spent ?? 0;

    if (isValidPrice(t.cur)) {
      totalCur += t.cur * (t.qty ?? 0);
      pricedCount += 1;
    }
  }

  const totalPL = totalCur - totalSpent;
  const totalPLPct = totalSpent > 0 ? (totalPL / totalSpent) * 100 : null;

  return { totalSpent, totalCur, totalPL, totalPLPct, pricedCount };
}, [table]);

  function onSort(key: string) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );
  }

  return (
	<div className="wrap appShell">

    {/* FIXED TOP AREA */}
    <div className="topbar">

      <header>
        <h1>Altcoin Tracker</h1>
        <div className="controls">
          <button
            className="btn"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "🌞 Light" : "🌙 Dark"}
          </button>
        </div>
      </header>

      <div className="controls" style={{ marginBottom: 8 }}>
        <button className="btn primary" onClick={refresh}>
          Refresh prices
        </button>

        <button
          className="btn"
          onClick={() => setCompact((v) => !v)}
        >
          {compact ? "Full version" : "Compact"}
        </button>

        <label className="checkbox">
          <input
            checked={profitOnly}
            onChange={(e) => setProfitOnly(e.target.checked)}
            type="checkbox"
          />{" "}
          Profit only
        </label>

        <label className="checkbox">
          <input
            checked={showTotals}
            onChange={(e) => setShowTotals(e.target.checked)}
            type="checkbox"
          />{" "}
          Totals
        </label>

        <input
          type="text"
          placeholder="Search token..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <label className="btn" style={{ position: "relative" }}>
          Upload Excel
          <input
            type="file"
            accept=".xlsx,.xls"
            style={{ position: "absolute", inset: 0, opacity: 0 }}
            onChange={onUploadXlsx}
          />
        </label>
      </div>

      {showTotals && (
        <div className="controls" style={{ marginBottom: 8 }}>
          <div className="muted">
            <b>Today total:</b> ${fmt(totals.totalCur, 2)}{" "}
            <span className={cx(colorPL(totals.totalPL))}>
              ({totals.totalPL >= 0 ? "+" : ""}
              {fmt(totals.totalPL, 2)}
              {totals.totalPLPct != null
                ? `, ${fmt(totals.totalPLPct, 2)}%`
                : ""}
              )
            </span>{" "}
            • Currently invested: ${fmt(totals.totalSpent, 2)} • Priced coins:{" "}
            {totals.pricedCount}/{table.length}
          </div>
        </div>
      )}
    </div>

    {/* SCROLLABLE TABLE AREA */}
	<div className={cx("tableWrap", compact ? "compact" : "full")}>
      <table>
        <thead>
          <tr>
            <Th label="Token" sortKey="token" sort={sort} onSort={onSort} />

            {!compact && (
              <Th label="Buy" sortKey="buy" sort={sort} onSort={onSort} right />
            )}
            {!compact && (
              <Th label="Current" sortKey="cur" sort={sort} onSort={onSort} right />
            )}
            {!compact && <th className="num">24h %</th>}
            {!compact && (
              <Th label="Qty" sortKey="qty" sort={sort} onSort={onSort} right />
            )}

            <Th label="Invested" sortKey="spent" sort={sort} onSort={onSort} right />
            <Th label="Value" sortKey="curVal" sort={sort} onSort={onSort} right />

            <Th
  label={compact ? "P/L" : "P/L $"}
  sortKey="pl"
  sort={sort}
  onSort={onSort}
  right
/>

<Th
  label={compact ? "%" : "P/L %"}
  sortKey="plPct"
  sort={sort}
  onSort={onSort}
  right
/>
          </tr>
        </thead>

        <tbody>
          {table.map((t, idx) => (
            <tr
              key={idx}
              onClick={() => setTvSymbol(`BINANCE:${t.sym}USDT`)}
              style={{ cursor: "pointer" }}
            >
              <td>
                <span>{t.sym}</span>
                {!compact && (
                  <span className="muted"> ({t.row.token})</span>
                )}
              </td>

              {!compact && <td className="num">{fmt(t.buy, 6)}</td>}
              {!compact && <td className="num">{fmt(t.cur, 6)}</td>}
              {!compact && <td className="num">{fmt(t.ch, 2)}</td>}
              {!compact && <td className="num">{fmt(t.qty, 6)}</td>}

              <td className="num">{fmt(t.spent, 2)}</td>
              <td className="num">{fmt(t.curVal, 2)}</td>

              <td className={cx("num", colorPL(t.pl))}>
                {fmt(t.pl, 2)}
              </td>

              <td className={cx("num", colorPL(t.plPct))}>
                {t.pl != null ? fmt(t.plPct, 2) + "%" : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    

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
            marginBottom: 0,
          }}
        >
          <div className="muted">Chart: {tvSymbol}</div>
          <button className="btn" onClick={() => setTvSymbol(null)}>
            Close
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          <div
            id="tv_chart_container"
            ref={tvRef}
            style={{ width: "100%", height: "100%" }}
          />
        </div>
      </div>
    </div>,
    document.body
  )}

    <footer>
      Click a row to open a TradingView chart (BINANCE: SYMBOLUSDT).
    </footer>
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
