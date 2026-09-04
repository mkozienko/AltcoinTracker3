import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const ids = searchParams.get("ids");
  const vs = searchParams.get("vs_currencies") || "usd";
  const include24h = searchParams.get("include_24hr_change") || "true";

  if (!ids) {
    return NextResponse.json({ error: "ids is required" }, { status: 400 });
  }

  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}` +
    `&vs_currencies=${encodeURIComponent(vs)}` +
    `&include_24hr_change=${encodeURIComponent(include24h)}`;

  const r = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      // Demo key from Vercel env
      "x-cg-demo-api-key": process.env.COINGECKO_DEMO_KEY || "",
    },
  });

  const text = await r.text();
  return new NextResponse(text, {
    status: r.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}
