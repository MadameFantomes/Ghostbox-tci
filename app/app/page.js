"use client";

import { useRef, useState } from "react";

/**
 * Étape 1 : jouer une radio live via <audio>.
 * - Station HTTPS CORS-friendly (RadioMast Reference).
 * - Pas encore de WebAudio/filtre/balayage : juste vérifier que le son sort.
 */

const STATIONS = [
  { name: "RadioMast Reference MP3", url: "https://streams.radiomast.io/reference-mp3" },
  { name: "RadioMast Reference AAC", url: "https://streams.radiomast.io/reference-aac" }
];

export default function Page() {
  const audioRef = useRef(null);
  const [idx, setIdx] = useState(0);
  const [status, setStatus] = useState("prêt");

  async function play() {
    const el = audioRef.current;
    if (!el) return;
    el.src = STATIONS[idx].url;
    setStatus("connexion…");
    try {
      await el.play(); // nécessite un clic utilisateur
      setStatus("lecture");
    } catch (e) {
      console.error(e);
      setStatus("échec lecture (CORS/format)");
    }
  }

  function stop() {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    el.src = "";
    el.load();
    setStatus("arrêté");
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{
        width: "min(720px, 100%)",
        background: "linear-gradient(180deg,#13131a,#0b0b10)",
        border: "1px solid #2b2b36",
        borderRadius: 16,
        padding: 20,
        boxShadow: "0 10px 40px rgba(0,0,0,0.45)"
      }}>
        <h1 style={{ marginTop: 0, marginBottom: 6, fontSize: 22 }}>Ghostbox TCI — Étape 1 (radio live)</h1>
        <div style={{ opacity: 0.75, fontSize: 13, marginBottom: 12 }}>
          Station: <strong>{STATIONS[idx].name}</strong> — <em>{status}</em>
        </div>

        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ display: "block", fontSize: 13, marginBottom: 6, opacity: 0.85 }}>Choisir une station</span>
          <select
            value={idx}
            onChange={(e) => setIdx(Number(e.target.value))}
            style={{ width: "100%", padding: 10, borderRadius: 10, background: "#1b1b26", color: "#eae7f5", border: "1px solid #2b2b36" }}
          >
            {STATIONS.map((s, i) => <option key={s.url} value={i}>{s.name}</option>)}
          </select>
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <button onClick={play} style={btn("#5b4dd6", "#6a5cf0")}>Démarrer</button>
          <button onClick={stop} style={btn("#e24b5a", "#ff5b6c")}>Arrêter</button>
        </div>

        {/* Élément audio caché qui joue la radio */}
        <audio ref={audioRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
      </div>
    </main>
  );
}

function btn(bg) {
  return {
    cursor: "pointer",
    border: "1px solid #2b2b36",
    borderRadius: 12,
    padding: "10px 14px",
    fontWeight: 600,
    fontSize: 14,
    background: bg,
    color: "#fff"
  };
}
