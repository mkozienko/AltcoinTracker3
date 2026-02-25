import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const vs = searchParams.get("vs_currency") || "usd";
  const ids = searchParams.get("ids");
  const pcp = searchParams.get("price_change_percentage") || "24h";

  if (!ids) {
    return NextResponse.json({ error: "ids is required" }, { status: 400 });
  }

  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${encodeURIComponent(vs)}` +
    `&ids=${encodeURIComponent(ids)}` +
    `&price_change_percentage=${encodeURIComponent(pcp)}`;

  const r = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "x-cg-demo-api-key": process.env.COINGECKO_DEMO_KEY || "",
    },
  });

  const text = await r.text();
  return new NextResponse(text, {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
}
