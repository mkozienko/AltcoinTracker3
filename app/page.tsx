
"use client";
import dynamic from "next/dynamic";

const AltcoinTrackerApp = dynamic(() => import("../components/AltcoinTrackerApp"), { ssr: false });
export default function Page(){ return <AltcoinTrackerApp />; }
