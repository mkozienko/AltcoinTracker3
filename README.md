# Altcoin Portfolio Tracker

A personal web app for tracking a crypto portfolio bought across several exchanges. Upload an Excel file with your purchases, and the app works out the average buy price for each token, fetches live prices, and shows profit and loss per position and for the whole portfolio.

<img width="1300" height="725" alt="Altcoin Portfolio Tracker" src="https://github.com/user-attachments/assets/f489a5db-4ec3-48c1-8e39-d2b39aaca9ae" />

**Live demo:** https://altcoin-tracker3.vercel.app

To try it, download [demo_portfolio.xlsx](demo_portfolio.xlsx) (sample data) and click **Upload Excel**.

## Features

- **Excel import.** Reads purchase history (price and quantity) from an `.xlsx` file. Purchases of the same token from different exchanges are combined.
- **Weighted average buy price.** Calculated for each token across all purchases.
- **Live prices** from the [CoinGecko API](https://www.coingecko.com/en/api), requested through the app's own server-side API routes so the API key is never exposed in the browser.
- **Profit and loss** for every position and for the portfolio as a whole.
- **Sorting** by any column, **search** by token, and a **profitable-only** filter.
- **Price chart.** Click any row to open an interactive TradingView chart for that token.
- **Light and dark themes**, and a compact view.
- **Installs on a phone** as a progressive web app (PWA).
- **Remembers your data** in the browser between visits.

## Excel file format

The app looks for a sheet named **`Buys`** with one row per purchase:

| Token | Buy price | ... | Quantity |
|-------|-----------|-----|----------|
| ADA   | 0.42      |     | 100      |
| ADA   | 0.38      |     | 50       |
| SOL   | 145.10    |     | 2        |

Column headers are detected by name, so common variations work, for example `Symbol` / `Coin` / `Ticker` for the token, `Price` / `Avg price` for the buy price, and `Qty` / `Amount` for the quantity.

An optional **`Summary`** sheet with one row per token (token, average price, quantity, and optionally remaining quantity) is also supported.

## Tech stack

- [Next.js 14](https://nextjs.org/) (App Router), React 18, TypeScript
- [SheetJS (xlsx)](https://sheetjs.com/) for reading Excel files
- CoinGecko API for prices, TradingView widget for charts
- Node.js built-in test runner for automated tests

## Project structure

```
app/
  api/coingecko/markets/       server route for market data
  api/coingecko/simple-price/  server route for current prices
  page.tsx, layout.tsx         app entry point
components/
  AltcoinTrackerApp.tsx        main UI: table, sorting, filters, charts
lib/
  portfolio.mjs                Excel parsing, average price and price logic
test/
  portfolio.test.mjs           automated tests for the portfolio logic
public/
  data/coingecko_map.json      token symbol to CoinGecko ID mapping
  manifest.json, icons/        PWA setup
```

## Getting started

Requirements: Node.js 18 or newer.

```bash
npm install
```

Get a free demo API key from CoinGecko and set it as an environment variable. Create a file named `.env.local` in the project folder:

```
COINGECKO_DEMO_KEY=your_key_here
```

This file is listed in `.gitignore`, so the key is never committed.

Then run the app:

```bash
npm run dev
```

Open http://localhost:3000 and upload your Excel file.

## Running tests

```bash
npm test
```

## Deployment

The app runs on [Vercel](https://vercel.com/). Add `COINGECKO_DEMO_KEY` in the project's environment variables.

## Disclaimer

This is a personal project for tracking my own portfolio. It is not financial advice.
