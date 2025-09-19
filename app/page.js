"use client";

/**
 * Ghostbox TCI — Radio Vintage (FR)
 * - Radio live (HTTPS)
 * - Mode normal (WebAudio complet) + Mode compatibilité (si CORS bloque)
 * - Contrôles FR : MARCHE, RÉGLAGE, VOLUME, BRUIT, FILTRE, BALAYAGE AUTO, VITESSE, ENREGISTRER
 * - VU-mètres, enregistrement .webm
 */

import React, { useEffect, useRef, useState } from "react";

// —————————————————— Stations conseillées (MP3 d'abord) ——————————————————
const STATIONS = [
  { name: "Référence MP3 (RadioMast)", url: "https://streams.radiomast.io/reference-mp3" }, // MP3: bon pour tests
  { name: "Référence AAC (RadioMast)", url: "https://streams.radiomast.io/reference-aac" },  // AAC: selon navigateur
  { name: "Swiss Jazz 96k (AAC)",      url: "https://stream.srg-ssr.ch/srgssr/rsj/aac/96" },
  { name: "Swiss Classic 96k (AAC)",   url: "https://stream.srg-ssr.ch/srgssr/rsc/aac/96" }
];

export default function Page() {
  const audioElRef = useRef(null);

  // WebAudio graph
  const ctxRef = useRef(null);
  const destRef = useRef(null);
  const masterGainRef = useRef(null);
  const mediaSrcRef = useRef(null);
  const radioGainRef = useRef(null);
  const noiseNodeRef = useRef(null);
  const noiseGainRef = useRef(null);
  const bandpassRef = useRef(null);
  const analyserRef = useRef(null);

  // UI
  const [marche, setMarche] = useState(false);
  const [stationIndex, setStationIndex] = useState(0);
  const [etat, setEtat] = useState("prêt");

  const [volume, setVolume] = useState(0.9);   // niveau radio
  const [bruit, setBruit]   = useState(0.25);  // bruit blanc
  const [filtre, setFiltre] = useState(true);
  const [q, setQ]     = useState(1.2);
  const [fMin, setFMin] = useState(280);

  const [autoSweep, setAutoSweep] = useState(false);
  const [vitesse, setVitesse] = useState(0.45); // 0..1  → 300..2000ms
  const sweepTimerRef = useRef(null);

  // Mode compatibilité (CORS)
  const [compat, setCompat] = useState(false);

  // Record
  const [enr, setEnr] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);

  // VU
  const [vuG, setVuG] = useState(0);
  const [vuD, setVuD] = useState(0);

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const msFromSpeed = (v) => Math.round(300 + v * (2000 - 300)); // 300ms → 2000ms

  // ——— Init
  async function initAudio() {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxRef.current = ctx;

    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    masterGainRef.current = master;

    const dest = ctx.createMediaStreamDestination();
    master.connect(dest);
    destRef.current = dest;

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = q;
    band.frequency.value = fMin;
    bandpassRef.current = band;

    const gRadio = ctx.createGain(); gRadio.gain.value = volume; radioGainRef.current = gRadio;
    const gNoise = ctx.createGain(); gNoise.gain.value = bruit;  noiseGainRef.current = gNoise;

    const noise = createNoiseNode(ctx); noiseNodeRef.current = noise;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyserRef.current = analyser;

    rechain(filtre, /*compat*/ false);
    master.connect(analyser);
    startVuLoop();
  }

  function rechain(useFilter, compatMode) {
    try { radioGainRef.current?.disconnect(); } catch {}
    try { noiseGainRef.current?.disconnect(); } catch {}
    try { bandpassRef.current?.disconnect(); } catch {}
    if (compatMode) {
      // en compat: seule la chaîne BRUIT passe par WebAudio (la radio lit directement)
      noiseGainRef.current.connect(masterGainRef.current);
      return;
    }
    if (useFilter) {
      radioGainRef.current.connect(bandpassRef.current);
      noiseGainRef.current.connect(bandpassRef.current);
      bandpassRef.current.connect(masterGainRef.current);
    } else {
      radioGainRef.current.connect(masterGainRef.current);
      noiseGainRef.current.connect(masterGainRef.current);
    }
  }

  function createNoiseNode(ctx) {
    const size = 2 * ctx.sampleRate; // 2s
    const buf = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * 0.9;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    return src;
  }

  async function attachMedia() {
    // essaie de brancher la radio au graphe WebAudio
    if (!ctxRef.current || !audioElRef.current) return;
    if (mediaSrcRef.current) {
      try { mediaSrcRef.current.disconnect(); } catch {}
      mediaSrcRef.current = null;
    }
    try {
      const src = ctxRef.current.createMediaElementSource(audioElRef.current);
      mediaSrcRef.current = src;
      src.connect(radioGainRef.current);
      setCompat(false); // succès : effet complet dispo
    } catch {
      // échec : CORS → compat
      setCompat(true);
    }
  }

  // ——— MARCHE
  async function marcheOn() {
    await initAudio();
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    try { noiseNodeRef.current.start(0); } catch {}
    await attachMedia();
    await tuneTo(stationIndex);
    setMarche(true);
  }
  function marcheOff() {
    stopSweepTimer();
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
      audioElRef.current.load();
    }
    setMarche(false);
    setEtat("arrêté");
  }

  // ——— Tuning
  async function tuneTo(index) {
    const el = audioElRef.current;
    if (!el) return;
    const { url } = STATIONS[index];

    // petit fondu “scan”
    smooth(noiseGainRef.current.gain, Math.max(bruit, 0.28), 0.12);
    if (!compat) smooth(radioGainRef.current.gain, Math.max(0.12, volume * 0.25), 0.12);

    el.crossOrigin = "anonymous"; // important avant src
    el.src = url;
    setEtat("connexion…");
    try {
      // en mode compat, on contrôle le volume de la balise <audio>
      el.volume = compat ? clamp01(volume) : 1.0;

      await el.play();
      setEtat(compat ? "lecture (compatibilité)" : "lecture");
      if (!compat) {
        smooth(radioGainRef.current.gain, volume, 0.28);
      }
      smooth(noiseGainRef.current.gain, bruit, 0.38);
    } catch {
      setEtat("échec (CORS/format)");
    }
  }

  function smooth(param, target, secs) {
    const ctx = ctxRef.current;
    const now = ctx.currentTime;
    try {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(target, now, Math.max(0.01, secs));
    } catch {}
  }

  // ——— Balayage auto
  function startSweepTimer() {
    stopSweepTimer();
    const interval = msFromSpeed(vitesse);
    sweepTimerRef.current = setInterval(() => {
      setStationIndex(prev => {
        const next = (prev + 1) % STATIONS.length;
        if (marche) tuneTo(next);
        return next;
      });
    }, interval);
  }
  function stopSweepTimer() {
    if (sweepTimerRef.current) clearInterval(sweepTimerRef.current);
    sweepTimerRef.current = null;
  }

  // ——— Enregistrer
  function toggleEnr() {
    if (!destRef.current) return;
    if (!enr) {
      const rec = new MediaRecorder(destRef.current.stream, { mimeType: "audio/webm;codecs=opus" });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `ghostbox-${new Date().toISOString().replace(/[:.]/g,"-")}.webm`;
        document.body.appendChild(a); a.click();
        setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); },0);
      };
      rec.start(); recRef.current = rec; setEnr(true);
    } else {
      recRef.current?.stop(); setEnr(false);
    }
  }

  // ——— Réactions
  useEffect(() => { if (radioGainRef.current) radioGainRef.current.gain.value = volume; if (audioElRef.current && compat) audioElRef.current.volume = clamp01(volume); }, [volume, compat]);
  useEffect(() => { if (noiseGainRef.current)  noiseGainRef.current.gain.value  = bruit; }, [bruit]);
  useEffect(() => { if (bandpassRef.current)   bandpassRef.current.Q.value     = q; }, [q]);
  useEffect(() => { if (bandpassRef.current)   bandpassRef.current.frequency.value = Math.max(60, fMin); }, [fMin]);
  useEffect(() => { if (ctxRef.current) rechain(filtre, compat); }, [filtre, compat]);

  useEffect(() => {
    if (!autoSweep) { stopSweepTimer(); return; }
    startSweepTimer();
    return stopSweepTimer;
  }, [autoSweep, vitesse, marche]);

  // ——— VU
  function startVuLoop() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    function loop() {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const lvl = Math.min(1, rms * 1.8);
      setVuG(l => l * 0.7 + lvl * 0.3);
      setVuD(r => r * 0.7 + (lvl * 0.9) * 0.3);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // ——— UI
  const tuneValue = STATIONS.length > 1 ? stationIndex / (STATIONS.length - 1) : 0;

  return (
    <main style={styles.page}>
      <div style={styles.shadowWrap}>
        <div style={styles.cabinet}>
          {/* entête */}
          <div style={styles.headerBar}>
            <div style={styles.brandPlate}>
              <div style={styles.brandText}>MADAME FANTÔMES</div>
              <div style={styles.brandSub}>Ghostbox • Formation TCI</div>
            </div>
            <div style={styles.lampsRow}>
              <Lamp label="MARCHE" on={marche} />
              <Lamp label="ENR" on={enr} colorOn="#ff5656" />
            </div>
          </div>

          {/* cadran */}
          <div style={styles.glass}>
            <div style={styles.scaleWrap}>
              <div style={styles.scaleGrid} />
              {STATIONS.map((s, i) => (
                <div key={s.url} style={{ ...styles.tick, left: `${(i/(STATIONS.length-1))*100}%` }} />
              ))}
              <div style={{ ...styles.needle, left: `${tuneValue*100}%` }} />
            </div>
            <div style={styles.stationRow}>
              <div><strong>{STATIONS[stationIndex].name}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && (
              <div style={styles.compatBanner}>
                Mode compatibilité CORS : filtre inactif sur la radio
              </div>
            )}
            <div style={styles.scratches} aria-hidden />
          </div>

          {/* grille + VU */}
          <div style={styles.speakerSection}>
            <div style={styles.grill} />
            <div style={styles.vuWrap}>
              <Vu label="NIVEAU G" value={vuG} />
              <Vu label="NIVEAU D" value={vuD} />
            </div>
          </div>

          {/* contrôles */}
          <div style={styles.controlsRow}>
            <div style={styles.colLeft}>
              <Switch label="MARCHE" on={marche} onChange={async v => { setMarche(v); v ? await marcheOn() : marcheOff(); }} />
              <Switch label="FILTRE" on={filtre} onChange={setFiltre} />
              <Switch label="BALAYAGE AUTO" on={autoSweep} onChange={setAutoSweep} />
              <Knob label="VITESSE" value={vitesse} onChange={v => setVitesse(clamp01(v))} hint={`${msFromSpeed(vitesse)} ms`} />
            </div>

            <div style={styles.colCenter}>
              <Knob label="VOLUME" value={volume} onChange={v => setVolume(clamp01(v))} />
              <Knob label="BRUIT"   value={bruit} onChange={v => setBruit(clamp01(v))} />
              <Bouton label={enr ? "STOP" : "ENREGISTRER"} color={enr ? "#f0c14b" : "#d94242"} onClick={toggleEnr} />
            </div>

            <div style={styles.colRight}>
              <BigKnob
                label="RÉGLAGE"
                value={tuneValue}
                onChange={async v => {
                  const idx = Math.round(clamp01(v) * (STATIONS.length - 1));
                  setStationIndex(idx);
                  if (marche) await tuneTo(idx);
                }}
              />
              <div style={styles.subDials}>
                <MiniDial label="Q" min={0.4} max={6} step={0.1} value={q} setValue={setQ} />
                <MiniDial label="fMin" min={60} max={2000} step={20} value={fMin} setValue={setFMin} />
                <Bouton label="SUIVANTE" onClick={async () => {
                  const next = (stationIndex + 1) % STATIONS.length;
                  setStationIndex(next); if (marche) await tuneTo(next);
                }} />
              </div>
            </div>
          </div>

          <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
        </div>

        <Vis at="tl" /><Vis at="tr" /><Vis at="bl" /><Vis at="br" />
      </div>

      <p style={{ color: "rgba(255,255,255,0.7)", marginTop: 14, fontSize: 12 }}>
        Tip : active <strong>MARCHE</strong> puis joue avec <strong>RÉGLAGE</strong>, <strong>FILTRE</strong> et <strong>BRUIT</strong>.
      </p>
    </main>
  );
}

/* ————— Widgets UI ————— */

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
        aria-label={label}
      >
        <div style={ui.knobIndicator} />
      </div>
      <div style={ui.knobLabel}>{label}</div>
      {hint && <div style={ui.hint}>{hint}</div>}
    </div>
  );
}

function BigKnob({ label, value, onChange }) {
  const [drag, setDrag] = useState(null);
  const angle = -135 + value * 270;
  return (
    <div style={ui.bigKnobBlock}>
      <div
        style={{ ...ui.bigKnob, transform: `rotate(${angle}deg)` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ x: e.clientX, y: e.clientY, v: value }); }}
        onPointerMove={(e) => { if (!drag) return; const dy = (drag.y - e.clientY) / 340; const dx = (e.clientX - drag.x) / 420; onChange(drag.v + dy + dx * 0.25); }}
        onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}
      >
        <div style={ui.bigKnobIndicator} />
      </div>
      <div style={ui.knobLabel}>{label}</div>
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

function MiniDial({ label, min, max, step, value, setValue }) {
  return (
    <div style={ui.miniDial}>
      <div style={ui.miniLabel}>{label}</div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => setValue(Number(e.target.value))} style={{ width: "100%" }} />
      <div style={ui.miniVal}>{Math.round(value)}</div>
    </div>
  );
}

function Vu({ label, value }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = pct < 60 ? "#7bdc8b" : pct < 85 ? "#f0c14b" : "#ff6a6a";
  return (
    <div style={vu.box}>
      <div style={vu.scale}><div style={{ ...vu.bar, width: `${pct}%`, background: color }} /></div>
      <div style={vu.label}>{label}</div>
    </div>
  );
}

function Vis({ at }) {
  const pos = { tl: { top: -8, left: -8 }, tr: { top: -8, right: -8 }, bl: { bottom: -8, left: -8 }, br: { bottom: -8, right: -8 } }[at];
  return <div style={{ ...decor.screw, ...pos }} />;
}

/* ————— Styles ————— */

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
    background:
      "linear-gradient(180deg,#4b3425,#3c2a1f 40%,#34241b 100%), " +
      "repeating-linear-gradient(45deg, rgba(255,255,255,0.05) 0 1px, rgba(0,0,0,0.06) 1px 2px)",
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
    background: "linear-gradient(180deg, rgba(16,18,26,0.95), rgba(10,12,18,0.95)), radial-gradient(800px 200px at 50% -80px, rgba(255,255,255,0.06), transparent 60%)",
    padding: 12, position: "relative", overflow: "hidden", boxShadow: "inset 0 0 28px rgba(0,0,0,0.5)"
  },
  scaleWrap: { position: "relative", height: 54, borderRadius: 10, border: "1px solid #252834", background: "#0d0f15", overflow: "hidden", marginBottom: 8 },
  scaleGrid: { position: "absolute", inset: 0, background: "repeating-linear-gradient(90deg, rgba(255,255,255,0.08) 0 2px, transparent 2px 12px)" },
  tick: { position: "absolute", top: 0, width: 2, height: "100%", background: "rgba(240,210,140,0.7)", transform: "translateX(-1px)" },
  needle: { position: "absolute", top: 0, width: 2, height: "100%", background: "#f05a6e", boxShadow: "0 0 10px rgba(240,90,110,0.7), 0 0 20px rgba(240,90,110,0.35)", transform: "translateX(-1px)" },
  stationRow: { display: "flex", justifyContent: "space-between", color: "#eae7f5", fontSize: 13, padding: "0 2px" },
  scratches: { position: "absolute", inset: 0, pointerEvents: "none", background: "linear-gradient(transparent, rgba(255,255,255,0.03) 20%, transparent 60%), repeating-linear-gradient(120deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 4px)" },

  compatBanner: {
    position: "absolute", right: 10, bottom: 10,
    background: "rgba(240,180,60,0.18)", border: "1px solid rgba(240,180,60,0.35)",
    color: "#f0c572", padding: "6px 10px", borderRadius: 8, fontSize: 12
  },

  speakerSection: { marginTop: 12, display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 },
  grill: {
    borderRadius: 14, border: "1px solid #282a32", height: 120,
    background: "radial-gradient(circle at 30% 30%, rgba(0,0,0,0.3), transparent 65%), repeating-linear-gradient(45deg, #1a1d27 0 6px, #131521 6px 12px)"
  },
  vuWrap: {
    borderRadius: 14, border: "1px solid #282a32", height: 120, padding: 12,
    background: "linear-gradient(180deg,#12141c,#0e1017)",
    display: "grid", gridTemplateRows: "1fr 1fr", gap: 10
  },

  controlsRow: { marginTop: 14, display: "grid", gridTemplateColumns: "1.05fr 1fr 1.05fr", gap: 14 },
  colLeft: { display: "grid", gridTemplateRows: "auto auto auto auto", gap: 10, alignContent: "start" },
  colCenter: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "center", justifyItems: "center" },
  colRight: { display: "grid", gridTemplateRows: "auto auto", gap: 10, justifyItems: "center", alignContent: "start" },
  subDials: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "center" }
};

const ui = {
  knobBlock: { display: "grid", justifyItems: "center" },
  knob: {
    width: 86, height: 86, borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, #4d505a, #2a2f3a 60%, #141821 100%)",
    border: "1px solid #1e2430",
    boxShadow: "inset 0 10px 26px rgba(0,0,0,0.6), 0 8px 24px rgba(0,0,0,0.45)",
    display: "grid", placeItems: "center", touchAction: "none", userSelect: "none", cursor: "grab", transition: "transform .05s linear"
  },
  knobIndicator: { width: 6, height: 26, borderRadius: 3, background: "#f6d8a8", boxShadow: "0 0 8px rgba(246,216,168,0.4)" },
  knobLabel: { color: "#f0e7d1", marginTop: 6, fontSize: 12, letterSpacing: 1.2 },
  hint: { color: "rgba(255,255,255,0.65)", fontSize: 11, marginTop: 2 },

  bigKnobBlock: { display: "grid", justifyItems: "center" },
  bigKnob: {
    width: 148, height: 148, borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, #5a5e68, #2a2f3a 60%, #141821 100%)",
    border: "1px solid #1e2430",
    boxShadow: "inset 0 12px 30px rgba(0,0,0,0.62), 0 10px 28px rgba(0,0,0,0.5)",
    display: "grid", placeItems: "center", touchAction: "none", userSelect: "none", cursor: "grab"
  },
  bigKnobIndicator: { width: 8, height: 34, borderRadius: 4, background: "#ffd28c", boxShadow: "0 0 12px rgba(255,210,140,0.55)" },

  switchBlock: { display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 10 },
  switchLabel: { color: "#f0e7d1", fontSize: 12, letterSpacing: 1.2 },
  switch: { width: 44, height: 20, borderRadius: 12, position: "relative", border: "1px solid #2b2b36" },
  switchDot: { width: 18, height: 18, borderRadius: "50%", background: "#0b0b10", border: "1px solid #2b2b36", position: "absolute", top: 1, left: 1, transition: "transform .15s" },

  button: { cursor: "pointer", border: "1px solid #2b2b36", borderRadius: 12, padding: "10px 14px", fontWeight: 800, fontSize: 13, color: "#0b0b10", boxShadow: "0 6px 18px rgba(0,0,0,0.35)" },

  lamp: { display: "grid", gridTemplateColumns: "auto auto", gap: 6, alignItems: "center" },
  lampDot: { width: 12, height: 12, borderRadius: "50%" },
  lampLabel: { color: "#e0d8c0", fontSize: 11, letterSpacing: 1 },

  miniDial: { display: "grid", gridTemplateRows: "auto auto auto", gap: 4, alignItems: "center" },
  miniLabel: { color: "#f0e7d1", fontSize: 11, letterSpacing: 1.2, textAlign: "center" },
  miniVal: { color: "rgba(255,255,255,0.8)", fontSize: 11, textAlign: "center" }
};

const vu = {
  box: { background: "linear-gradient(180deg,#171923,#0f121a)", border: "1px solid #262a36", borderRadius: 10, padding: 8, boxShadow: "inset 0 0 22px rgba(0,0,0,0.5)", display: "grid", gridTemplateRows: "1fr auto", gap: 6 },
  scale: { height: 12, borderRadius: 8, background: "linear-gradient(180deg,#0b0e15,#0a0c12)", border: "1px solid #242837", overflow: "hidden", position: "relative" },
  bar: { position: "absolute", top: 0, left: 0, bottom: 0, background: "#7bdc8b", transition: "width 60ms linear" },
  label: { color: "#cfc8b0", fontSize: 10, textAlign: "right", opacity: 0.85 }
};

const decor = {
  screw: {
    position: "absolute", width: 18, height: 18, borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, #9aa0ad, #4b515e 60%, #1e232d)",
    border: "1px solid #222834",
    boxShadow: "0 8px 20px rgba(0,0,0,0.5), inset 0 3px 8px rgba(0,0,0,0.6)"
  }
};
