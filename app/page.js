"use client";

/**
 * Ghostbox TCI — UI simple (FR)
 * Contrôles: MARCHE, BALAYAGE AUTO, VITESSE, VOLUME, ÉCHO, DÉBIT (bruit de balayage)
 * - Bruit blanc audible ENTRE stations (durée/intensité = "DÉBIT")
 * - Écho simple (mix + feedback doux)
 * - Compat CORS: si un flux bloque WebAudio, la radio joue quand même; on mute la radio
 *   pendant le burst de bruit via <audio>.volume pour garder l'effet de balayage.
 * - Lit un gros catalogue si /stations.json existe (sinon fallback).
 * - Fond SVG aquarelle: /radio-vintage.svg
 */

import React, { useEffect, useRef, useState } from "react";

/* ——— Fallback minimal si /stations.json n'est pas trouvé ——— */
const FALLBACK_STATIONS = [
  "https://icecast.radiofrance.fr/fip-midfi.mp3",
  "https://icecast.radiofrance.fr/fiprock-midfi.mp3",
  "https://icecast.radiofrance.fr/fipjazz-midfi.mp3",
  "https://icecast.radiofrance.fr/fipgroove-midfi.mp3",
  "https://stream.srg-ssr.ch/srgssr/rsj/aac/96",
  "https://stream.srg-ssr.ch/srgssr/rsc/aac/96",
  "https://stream.srg-ssr.ch/srgssr/rsp/aac/96"
].map((url) => ({ name: url.split("/")[2], url }));

export default function Page() {
  const audioElRef = useRef(null);

  // AudioContext & nodes
  const ctxRef = useRef(null);
  const masterRef = useRef(null);
  const destRef = useRef(null);

  const mediaSrcRef = useRef(null);
  const radioGainRef = useRef(null);

  const noiseNodeRef = useRef(null);
  const noiseGainRef = useRef(null);

  // Echo (simple)
  const echoDelayRef = useRef(null);
  const echoFbRef = useRef(null);
  const echoWetRef = useRef(null);
  const dryRef = useRef(null);

  // UI state
  const [stations, setStations] = useState(FALLBACK_STATIONS);
  const [idx, setIdx] = useState(0);
  const [etat, setEtat] = useState("prêt");
  const [marche, setMarche] = useState(false);
  const [auto, setAuto] = useState(false);

  // 4 réglages demandés
  const [vitesse, setVitesse] = useState(0.45); // 0..1 → 250..2500ms
  const [volume, setVolume]   = useState(0.9);  // master
  const [echo, setEcho]       = useState(0.3);  // 0..1 → mix + fb léger
  const [debit, setDebit]     = useState(0.5);  // 0..1 → durée/intensité du bruit inter-station

  const sweepTimerRef = useRef(null);
  const [compat, setCompat] = useState(false);

  // Helpers
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const msFromSpeed = (v) => Math.round(250 + v * (2500 - 250)); // 250..2500 ms
  const burstMs = () => Math.round(40 + debit * 420);            // 40..460 ms de bruit
  const burstGain = () => 0.15 + debit * 0.85;                   // niveau de bruit 0.15..1
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ——— Charger un gros catalogue si présent ——— */
  useEffect(() => {
    fetch("/stations.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json) => {
        // Aplatit { "Groupe": [ {name,url}, ... ], ... } → [{name,url}, ...]
        const flat = Object.values(json)
          .flat()
          .filter((s) => s && s.url)
          .map((s) => ({ name: s.name || s.url.split("/")[2], url: s.url }));
        if (flat.length) setStations(flat);
      })
      .catch(() => {}); // fallback déjà prêt
  }, []);

  /* ——— Init WebAudio ——— */
  async function initAudio() {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxRef.current = ctx;

    // master + enregistrement
    const master = ctx.createGain(); master.gain.value = volume; master.connect(ctx.destination);
    masterRef.current = master;
    const dest = ctx.createMediaStreamDestination(); master.connect(dest);
    destRef.current = dest;

    // voie radio
    const gRadio = ctx.createGain(); gRadio.gain.value = 1; radioGainRef.current = gRadio;

    // bruit blanc (pour le balayage)
    const gNoise = ctx.createGain(); gNoise.gain.value = 0; noiseGainRef.current = gNoise;
    const noise = createNoiseNode(ctx); noiseNodeRef.current = noise;

    // split dry/FX
    const dry = ctx.createGain(); dry.gain.value = 1; dryRef.current = dry;

    // ÉCHO simple (mix & fb)
    const dly = ctx.createDelay(1.2); dly.delayTime.value = 0.32;
    const fb  = ctx.createGain(); fb.gain.value = 0.25; // ajusté par setEcho()
    dly.connect(fb); fb.connect(dly);
    const wet = ctx.createGain(); wet.gain.value = 0;   // mix, ajusté par setEcho()

    echoDelayRef.current = dly; echoFbRef.current = fb; echoWetRef.current = wet;

    // Routing: (radio + bruit) → dry + echo → master
    const sum = ctx.createGain(); sum.gain.value = 1;
    gRadio.connect(sum); gNoise.connect(sum);

    sum.connect(dry);  dry.connect(master);
    sum.connect(dly);  dly.connect(wet);  wet.connect(master);

    try { noise.start(0); } catch {}
  }

  function createNoiseNode(ctx) {
    const size = 2 * ctx.sampleRate;
    const buf = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * 0.9;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    return src;
  }

  async function attachMedia() {
    if (!ctxRef.current || !audioElRef.current) return;
    if (mediaSrcRef.current) return;
    try {
      const src = ctxRef.current.createMediaElementSource(audioElRef.current);
      mediaSrcRef.current = src; src.connect(radioGainRef.current);
      setCompat(false);
    } catch {
      // CORS bloque WebAudio → lecture directe uniquement
      setCompat(true);
    }
  }

  /* ——— MARCHE ——— */
  async function powerOn() {
    await initAudio();
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    await tuneTo(idx);
    setMarche(true);
  }
  function powerOff() {
    stopSweep();
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
      audioElRef.current.load();
    }
    setMarche(false);
    setEtat("arrêté");
  }

  /* ——— Bruit inter-stations + tuning ——— */
  async function tuneTo(nextIndex) {
    const el = audioElRef.current; if (!el) return;
    const url = stations[nextIndex]?.url || stations[nextIndex];

    // 1) burst de bruit — on baisse la radio, on monte le bruit
    const ctx = ctxRef.current;
    const now = ctx.currentTime;
    const burstDur = burstMs() / 1000;

    if (!compat) {
      // via WebAudio
      try {
        radioGainRef.current.gain.cancelScheduledValues(now);
        radioGainRef.current.gain.linearRampToValueAtTime(0.0001, now + 0.06);
      } catch {}
      try {
        noiseGainRef.current.gain.cancelScheduledValues(now);
        noiseGainRef.current.gain.setTargetAtTime(burstGain(), now, 0.04);
      } catch {}
    } else {
      // compat: on mute la balise <audio> le temps du bruit
      el.volume = 0;
      try {
        noiseGainRef.current.gain.cancelScheduledValues(now);
        noiseGainRef.current.gain.setTargetAtTime(burstGain(), now, 0.04);
      } catch {}
    }

    setEtat("balayage…");
    await sleep(Math.max(60, burstMs() * 0.45));

    // 2) charger et jouer la station suivante
    try {
      el.crossOrigin = "anonymous";
      el.pause(); el.src = url; el.load();
      await el.play();
      setEtat("connexion…");
    } catch (e) {
      setEtat("échec (CORS/format)");
      return;
    }

    // 3) tenter de brancher la radio dans WebAudio (si possible)
    await attachMedia();

    // 4) fondu retour: on remonte la radio, on coupe le bruit
    const after = ctx.currentTime + Math.max(0.08, burstDur * 0.6);
    if (!compat) {
      try {
        radioGainRef.current.gain.setTargetAtTime(1, after, 0.08);
      } catch {}
    } else {
      el.volume = clamp01(volume);
    }
    try {
      noiseGainRef.current.gain.setTargetAtTime(0.0001, after, 0.1);
    } catch {}

    setIdx(nextIndex);
    setEtat(compat ? "lecture (compatibilité)" : "lecture");
  }

  /* ——— Balayage AUTO ——— */
  function startSweep() {
    stopSweep();
    const step = async () => {
      if (!marche) return;
      const next = (idx + 1) % stations.length;
      await tuneTo(next);
      sweepTimerRef.current = setTimeout(step, msFromSpeed(vitesse));
    };
    sweepTimerRef.current = setTimeout(step, msFromSpeed(vitesse));
  }
  function stopSweep() {
    if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current);
    sweepTimerRef.current = null;
  }

  /* ——— Réactions aux contrôles ——— */
  useEffect(() => {
    if (masterRef.current) masterRef.current.gain.value = clamp01(volume);
    if (audioElRef.current && compat) audioElRef.current.volume = clamp01(volume);
  }, [volume, compat]);

  useEffect(() => {
    // un seul bouton "ÉCHO": on pilote mix + un peu de feedback
    if (!echoWetRef.current || !echoFbRef.current) return;
    echoWetRef.current.gain.value = echo * 0.9;     // mix
    echoFbRef.current.gain.value = Math.min(0.6, echo * 0.6); // feedback doux
  }, [echo]);

  useEffect(() => {
    if (!auto) { stopSweep(); return; }
    if (marche) startSweep();
    return stopSweep;
  }, [auto, vitesse, marche, idx, stations.length]);

  /* ——— UI ——— */
  const currentName = stations[idx]?.name || new URL(stations[idx]?.url || stations[idx]).host;

  return (
    <main style={styles.page}>
      <div style={styles.shadowWrap}>
        <div style={styles.cabinet}>
          {/* Titre + voyants */}
          <div style={styles.headerBar}>
            <div style={styles.brandPlate}>
              <div style={styles.brandText}>MADAME FANTÔMES</div>
              <div style={styles.brandSub}>Ghostbox • Formation TCI</div>
            </div>
            <div style={styles.lampsRow}>
              <Lamp label="MARCHE" on={marche} />
              <Lamp label="AUTO" on={auto} colorOn="#86fb6a" />
            </div>
          </div>

          {/* Cadran */}
          <div style={styles.glass}>
            <div style={styles.stationRow}>
              <div><strong>{currentName}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && (
              <div style={styles.compatBanner}>Compat CORS : traitement radio limité</div>
            )}
          </div>

          {/* Contrôles */}
          <div style={styles.controlsRow}>
            <div style={styles.switches}>
              <Switch
                label="MARCHE"
                on={marche}
                onChange={async v => { setMarche(v); v ? await powerOn() : powerOff(); }}
              />
              <Switch
                label="BALAYAGE AUTO"
                on={auto}
                onChange={(v) => setAuto(v)}
              />
              <Bouton
                label="SUIVANTE"
                onClick={async () => { const next = (idx + 1) % stations.length; await tuneTo(next); }}
              />
            </div>

            <div style={styles.knobs}>
              <Knob label="VITESSE" value={vitesse} onChange={(v) => setVitesse(clamp01(v))} hint={`${msFromSpeed(vitesse)} ms`} />
              <Knob label="VOLUME"  value={volume}  onChange={(v) => setVolume(clamp01(v))} />
              <Knob label="ÉCHO"    value={echo}    onChange={(v) => setEcho(clamp01(v))} />
              <Knob label="DÉBIT"   value={debit}   onChange={(v) => setDebit(clamp01(v))} hint={`${burstMs()} ms bruit`} />
            </div>
          </div>

          <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
        </div>

        <Vis at="tl" /><Vis at="tr" /><Vis at="bl" /><Vis at="br" />
      </div>

      <p style={{ color: "rgba(255,255,255,0.7)", marginTop: 10, fontSize: 12 }}>
        Astuce : mets <strong>AUTO</strong>, ajuste <strong>VITESSE</strong> et <strong>DÉBIT</strong> pour bien entendre le <em>bruit de balayage</em> entre les stations.
      </p>
    </main>
  );
}

/* ——— Widgets UI ——— */

function Knob({ label, value, onChange, hint }) {
  const [drag, setDrag] = useState(null);
  const angle = -135 + value * 270;
  return (
    <div style={ui.knobBlock}>
      <div
        style={{ ...ui.knob, transform: `rotate(${angle}deg)` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ y: e.clientY, v: value }); }}
        onPointerMove={(e) => { if (!drag) return; const d = (drag.y - e.clientY) / 220; onChange(drag.v + d); }}
        onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}
      >
        <div style={ui.knobIndicator} />
      </div>
      <div style={ui.knobLabel}>{label}</div>
      {hint && <div style={ui.hint}>{hint}</div>}
    </div>
  );
}

function Switch({ label, on, onChange }) {
  return (
    <div style={ui.switchBlock} onClick={() => onChange(!on)}>
      <div style={ui.switchLabel}>{label}</div>
      <div style={{ ...ui.switch, background: on ? "#6ad27a" : "#464a58" }}>
        <div style={{ ...ui.switchDot, transform: `translateX(${on ? 20 : 0}px)` }} />
      </div>
    </div>
  );
}

function Bouton({ label, onClick, color = "#5b4dd6" }) {
  return <button onClick={onClick} style={{ ...ui.button, background: color }}>{label}</button>;
}

function Lamp({ label, on, colorOn = "#86fb6a" }) {
  return (
    <div style={ui.lamp}>
      <div style={{ ...ui.lampDot, background: on ? colorOn : "#191c24", boxShadow: on ? "0 0 12px rgba(134,251,106,0.6)" : "none" }} />
      <div style={ui.lampLabel}>{label}</div>
    </div>
  );
}

function Vis({ at }) {
  const pos = { tl: { top: -8, left: -8 }, tr: { top: -8, right: -8 }, bl: { bottom: -8, left: -8 }, br: { bottom: -8, right: -8 } }[at];
  return <div style={{ ...decor.screw, ...pos }} />;
}

/* ——— Styles ——— */

const styles = {
  page: {
    minHeight: "100vh",
    background: "radial-gradient(1600px 700px at 50% -200px, #1a1920, #0b0b10 60%)",
    display: "grid", placeItems: "center", padding: 24
  },
  shadowWrap: { position: "relative" },
  cabinet: {
    width: "min(980px, 94vw)", borderRadius: 26, padding: 16,
    border: "1px solid rgba(30,20,10,0.6)",
    boxShadow: "0 28px 80px rgba(0,0,0,0.65), inset 0 0 0 1px rgba(255,255,255,0.03)",
    backgroundImage: "url('/radio-vintage.svg'), linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.18))",
    backgroundSize: "cover", backgroundPosition: "center",
    position: "relative", overflow: "hidden"
  },
  headerBar: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  brandPlate: {
    background: "linear-gradient(180deg,#2a2b30,#1b1c23)", color: "#e8e3d6",
    borderRadius: 10, border: "1px solid #2a2c36", padding: "8px 12px",
    boxShadow: "inset 0 0 18px rgba(0,0,0,0.45)"
  },
  brandText: { fontWeight: 800, letterSpacing: 2, fontSize: 13 },
  brandSub: { fontSize: 11, opacity: 0.75 },
  lampsRow: { display: "flex", gap: 14, alignItems: "center" },

  glass: {
    borderRadius: 16, border: "1px solid #2b2e3a",
    background: "linear-gradient(180deg, rgba(16,18,26,0.9), rgba(10,12,18,0.9))",
    padding: 12, position: "relative", overflow: "hidden", boxShadow: "inset 0 0 28px rgba(0,0,0,0.5)"
  },
  stationRow: { display: "flex", justifyContent: "space-between", color: "#eae7f5", fontSize: 13, padding: "2px 2px" },

  compatBanner: {
    position: "absolute", right: 10, bottom: 10,
    background: "rgba(240,180,60,0.18)", border: "1px solid rgba(240,180,60,0.35)",
    color: "#f0c572", padding: "6px 10px", borderRadius: 8, fontSize: 12
  },

  controlsRow: { marginTop: 16, display: "grid", gridTemplateColumns: "1fr 2fr", gap: 14, alignItems: "center" },
  switches: { display: "grid", gap: 10, alignContent: "start" },
  knobs: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(120px, 1fr))",
    gap: 14,
    alignItems: "center",
    justifyItems: "center"
  }
};

const ui = {
  knobBlock: { display: "grid", justifyItems: "center" },
  knob: {
    width: 100, height: 100, borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, #5a5e68, #2a2f3a 60%, #141821 100%)",
    border: "1px solid #1e2430",
    boxShadow: "inset 0 12px 30px rgba(0,0,0,0.6), 0 10px 28px rgba(0,0,0,0.45)",
    display: "grid", placeItems: "center", touchAction: "none", userSelect: "none", cursor: "grab"
  },
  knobIndicator: { width: 8, height: 34, borderRadius: 4, background: "#ffd28c", boxShadow: "0 0 12px rgba(255,210,140,0.55)" },
  knobLabel: { color: "#f0e7d1", marginTop: 6, fontSize: 13, letterSpacing: 1.2, textAlign: "center" },
  hint: { color: "rgba(255,255,255,0.65)", fontSize: 11, marginTop: 2 },

  switchBlock: { display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 10, cursor: "pointer" },
  switchLabel: { color: "#f0e7d1", fontSize: 12, letterSpacing: 1.2 },
  switch: { width: 56, height: 24, borderRadius: 14, position: "relative", border: "1px solid #2b2b36" },
  switchDot: { width: 22, height: 22, borderRadius: "50%", background: "#0b0b10", border: "1px solid #2b2b36", position: "absolute", top: 1, left: 1, transition: "transform .15s" },

  button: {
    cursor: "pointer",
    border: "1px solid #2b2b36",
    borderRadius: 12,
    padding: "10px 14px",
    fontWeight: 800,
    fontSize: 13,
    color: "#0b0b10",
    boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
    background: "#5b4dd6"
  },

  lamp: { display: "grid", gridTemplateColumns: "auto auto", gap: 6, alignItems: "center" },
  lampDot: { width: 12, height: 12, borderRadius: "50%" },
  lampLabel: { color: "#e0d8c0", fontSize: 11, letterSpacing: 1 }
};

const decor = {
  screw: {
    position: "absolute", width: 18, height: 18, borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, #9aa0ad, #4b515e 60%, #1e232d)",
    border: "1px solid #222834",
    boxShadow: "0 8px 20px rgba(0,0,0,0.5), inset 0 3px 8px rgba(0,0,0,0.6)"
  }
};
