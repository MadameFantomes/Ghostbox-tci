"use client";
import { useRef, useState } from "react";

const STATIONS = [
  { name: "RadioMast Reference MP3", url: "https://streams.radiomast.io/reference-mp3" },
  { name: "RadioMast Reference AAC", url: "https://streams.radiomast.io/reference-aac" }
];

export default function Page() {
  const audioRef = useRef(null);
  const [idx, setIdx] = useState(0);
  const [status, setStatus] = useState("prêt");

  async function play() {
    const el = audioRef.current; if (!el) return;
    el.src = STATIONS[idx].url;
    setStatus("connexion…");
    try { await el.play(); setStatus("lecture"); }
    catch { setStatus("échec lecture (CORS/format)"); }
  }

  function stop() {
    const el = audioRef.current; if (!el) return;
    el.pause(); el.src = ""; el.load(); setStatus("arrêté");
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ width: "min(720px, 100%)", background: "linear-gradient(180deg,#13131a,#0b0b10)", border: "1px solid #2b2b36", borderRadius: 16, padding: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Ghostbox TCI — Étape 1 (radio live)</h1>
        <div style={{ opacity: 0.75, fontSize: 13, margin: "8px 0 12px" }}>
          Station : <strong>{STATIONS[idx].name}</strong> — <em>{status}</em>
        </div>
        <select value={idx} onChange={(e)=>setIdx(Number(e.target.value))} style={{ width: "100%", padding: 10, borderRadius: 10, background: "#1b1b26", color: "#eae7f5", border: "1px solid #2b2b36", marginBottom: 12 }}>
          {STATIONS.map((s,i)=><option key={s.url} value={i}>{s.name}</option>)}
        </select>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <button onClick={play} style={{cursor:"pointer",border:"1px solid #2b2b36",borderRadius:12,padding:"10px 14px",fontWeight:600,background:"#5b4dd6",color:"#fff"}}>Démarrer</button>
          <button onClick={stop}  style={{cursor:"pointer",border:"1px solid #2b2b36",borderRadius:12,padding:"10px 14px",fontWeight:600,background:"#e24b5a",color:"#fff"}}>Arrêter</button>
        </div>
        <audio ref={audioRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
      </div>
    </main>
  );
}
