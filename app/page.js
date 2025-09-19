"use client";

/**
 * Ghostbox TCI — Simple FR (balayage toutes stations)
 * - Lit /public/stations.json si présent (formats acceptés: tableau [{name,url}] ou objet {Groupe:[{name,url}|{name,urls:[]}]}).
 * - Déplie urls[], déduplique par URL, ne garde que HTTPS.
 * - Balayage AUTO corrigé (index courant via ref).
 * - Contrôles: MARCHE, BALAYAGE AUTO, VITESSE, VOLUME, ÉCHO, DÉBIT (bruit inter-station).
 * - Fond: /radio-vintage.svg.
 */

import React, { useEffect, useRef, useState } from "react";

/* ——— Fallback minimal si /stations.json absent ——— */
const FALLBACK_STATIONS = [
  "https://icecast.radiofrance.fr/fip-midfi.mp3",
  "https://icecast.radiofrance.fr/fiprock-midfi.mp3",
  "https://icecast.radiofrance.fr/fipjazz-midfi.mp3",
  "https://icecast.radiofrance.fr/fipgroove-midfi.mp3",
  "https://stream.srg-ssr.ch/srgssr/rsj/aac/96",
  "https://stream.srg-ssr.ch/srgssr/rsc/aac/96",
  "https://stream.srg-ssr.ch/srgssr/rsp/aac/96"
].map((url) => ({ name: new URL(url).host, url }));

export default function Page() {
  const audioElRef = useRef(null);

  // Audio graph
  const ctxRef = useRef(null);
  const masterRef = useRef(null);
  const destRef = useRef(null);
  const mediaSrcRef = useRef(null);
  const radioGainRef = useRef(null);
  const noiseNodeRef = useRef(null);
  const noiseGainRef = useRef(null);
  const dryRef = useRef(null);
  const echoDelayRef = useRef(null);
  const echoFbRef = useRef(null);
  const echoWetRef = useRef(null);

  // Stations et index
  const [stations, setStations] = useState(FALLBACK_STATIONS);
  const stationsRef = useRef(FALLBACK_STATIONS);
  const [idx, setIdx] = useState(0);
  const idxRef = useRef(0);

  // UI
  const [etat, setEtat] = useState("prêt");
  const [marche, setMarche] = useState(false);
  const [auto, setAuto] = useState(false);
  const [compat, setCompat] = useState(false);
  const sweepTimerRef = useRef(null);

  // 4 contrôles
  const [vitesse, setVitesse] = useState(0.45); // 0..1 → 250..2500ms
  const [volume, setVolume]   = useState(0.9);  // master
  const [echo, setEcho]       = useState(0.3);  // mix + fb doux
  const [debit, setDebit]     = useState(0.5);  // durée/intensité bruit blanc

  // Helpers
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const msFromSpeed = (v) => Math.round(250 + v * (2500 - 250));  // 250..2500 ms
  const burstMs = () => Math.round(40 + debit * 420);             // 40..460 ms
  const burstGain = () => 0.15 + debit * 0.85;                    // 0.15..1
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ——— Charge /stations.json si présent ——— */
  useEffect(() => {
    fetch("/stations.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json) => {
        const flat = normalizeStationsJson(json);
        if (flat.length) {
          setStations(flat);
          stationsRef.current = flat;
          // si on était hors bornes, on remet à 0
          setIdx(0); idxRef.current = 0;
        }
      })
      .catch(() => {
        stationsRef.current = FALLBACK_STATIONS;
      });
  }, []);

  function normalizeStationsJson(json) {
    let list = [];
    const push = (name, url, suffix="") => {
      if (!url || typeof url !== "string") return;
      if (!/^https:/i.test(url)) return; // HTTPS only
      list.push({ name: name || new URL(url).host + suffix, url });
    };

    if (Array.isArray(json)) {
      json.forEach((s, i) => {
        if (!s) return;
        if (s.url) push(s.name, s.url);
        if (Array.isArray(s.urls)) s.urls.forEach((u, k) => push(s.name, u, ` #${k+1}`));
      });
    } else if (json && typeof json === "object") {
      Object.entries(json).forEach(([group, arr]) => {
        if (!Array.isArray(arr)) return;
        arr.forEach((s, i) => {
          if (!s) return;
          if (s.url) push(s.name || `${group}`, s.url);
          if (Array.isArray(s.urls)) s.urls.forEach((u, k) => push(s.name || `${group}`, u, ` #${k+1}`));
        });
      });
    }

    // dédup par URL
    const seen = new Set();
    list = list.filter((s) => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    // option: mélange pour varier
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  /* ——— Init audio ——— */
  async function initAudio() {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxRef.current = ctx;

    const master = ctx.createGain(); master.gain.value = volume; master.connect(ctx.destination);
    masterRef.current = master;
    const dest = ctx.createMediaStreamDestination(); master.connect(dest);
    destRef.current = dest;

    const gRadio = ctx.createGain(); gRadio.gain.value = 1; radioGainRef.current = gRadio;

    const gNoise = ctx.createGain(); gNoise.gain.value = 0; noiseGainRef.current = gNoise;
    const noise = createNoiseNode(ctx); noiseNodeRef.current = noise; try { noise.start(0); } catch {}

    const dry = ctx.createGain(); dry.gain.value = 1; dryRef.current = dry;

    const dly = ctx.createDelay(1.2); dly.delayTime.value = 0.32;
    const fb  = ctx.createGain(); fb.gain.value = 0.25;
    dly.connect(fb); fb.connect(dly);
    const wet = ctx.createGain(); wet.gain.value = 0;
    echoDelayRef.current = dly; echoFbRef.current = fb; echoWetRef.current = wet;

    const sum = ctx.createGain(); sum.gain.value = 1;
    gRadio.connect(sum); gNoise.connect(sum);
    sum.connect(dry);  dry.connect(master);
    sum.connect(dly);  dly.connect(wet); wet.connect(master);
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
      setCompat(true); // CORS bloque WebAudio
    }
  }

  /* ——— Power ——— */
  async function powerOn() {
    await initAudio();
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    await tuneTo(idxRef.current);
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

  /* ——— Tuning + bruit inter-stations ——— */
  async function tuneTo(nextIndex) {
    const el = audioElRef.current; if (!el) return;
    const list = stationsRef.current;
    const entry = list[nextIndex];
    if (!entry) return;
    const url = typeof entry === "string" ? entry : entry.url;

    // Burst de bruit (balayage)
    const ctx = ctxRef.current;
    const now = ctx.currentTime;
    const burstDur = burstMs() / 1000;

    if (!compat) {
      try {
        radioGainRef.current.gain.cancelScheduledValues(now);
        radioGainRef.current.gain.linearRampToValueAtTime(0.0001, now + 0.06);
      } catch {}
      try {
        noiseGainRef.current.gain.cancelScheduledValues(now);
        noiseGainRef.current.gain.setTargetAtTime(burstGain(), now, 0.04);
      } catch {}
    } else {
      el.volume = 0; // mute <audio> en compat pendant le bruit
      try {
        noiseGainRef.current.gain.cancelScheduledValues(now);
        noiseGainRef.current.gain.setTargetAtTime(burstGain(), now, 0.04);
      } catch {}
    }

    setEtat("balayage…");
    await sleep(Math.max(60, burstMs() * 0.45));

    // Charger/lecture
    try {
      el.crossOrigin = "anonymous";
      el.pause(); el.src = url; el.load();
      await el.play();
      setEtat("connexion…");
    } catch (e) {
      setEtat("échec (CORS/format)");
      return;
    }

    await attachMedia();

    // Fondu retour
    const after = ctx.currentTime + Math.max(0.08, burstDur * 0.6);
    if (!compat) {
      try { radioGainRef.current.gain.setTargetAtTime(1, after, 0.08); } catch {}
    } else {
      el.volume = clamp01(volume);
    }
    try { noiseGainRef.current.gain.setTargetAtTime(0.0001, after, 0.1); } catch {}

    // Met à jour l’index courant (state + ref)
    idxRef.current = nextIndex;
    setIdx(nextIndex);
    setEtat(compat ? "lecture (compatibilité)" : "lecture");
  }

  /* ——— Balayage AUTO (corrigé: utilise idxRef) ——— */
  function startSweep() {
    stopSweep();
    const step = async () => {
      if (!marche) return;
      const list = stationsRef.current;
      if (!list.length) return;
      const next = (idxRef.current + 1) % list.length;
      await tuneTo(next);
      sweepTimerRef.current = setTimeout(step, msFromSpeed(vitesse));
    };
    sweepTimerRef.current = setTimeout(step, msFromSpeed(vitesse));
  }
  function stopSweep() {
    if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current);
    sweepTimerRef.current = null;
  }

  /* ——— Réactions contrôles ——— */
  useEffect(() => {
    if (masterRef.current) masterRef.current.gain.value = clamp01(volume);
    if (audioElRef.current && compat) audioElRef.current.volume = clamp01(volume);
  }, [volume, compat]);

  useEffect(() => {
    if (!echoWetRef.current || !echoFbRef.current) return;
    echoWetRef.current.gain.value = echo * 0.9;
    echoFbRef.current.gain.value = Math.min(0.6, echo * 0.6);
  }, [echo]);

  useEffect(() => {
    if (!auto) { stopSweep(); return; }
    if (marche) startSweep();
    return stopSweep;
  }, [auto, vitesse, marche]);

  /* ——— UI ——— */
  const list = stationsRef.current;
  const currentName = list[idxRef.current]?.name || (list[idxRef.current]?.url ? new URL(list[idxRef.current].url).host : "");

  return (
    <main style={styles.page}>
      <div style={styles.shadowWrap}>
        <div style={styles.cabinet}>
          {/* Titre + badge nombre de stations */}
          <div style={styles.headerBar}>
            <div style={styles.brandPlate}>
              <div style={styles.brandText}>MADAME FANTÔMES</div>
              <div style={styles.brandSub}>Ghostbox • Formation TCI</div>
            </div>
            <div style={styles.rightHeader}>
              <div style={styles.badge}>{list.length} stations chargées</div>
              <div style={styles.lampsRow}>
                <Lamp label="MARCHE" on={marche} />
                <Lamp label="AUTO" on={auto} colorOn="#86fb6a" />
              </div>
            </div>
          </div>

          {/* Cadran / état */}
          <div style={styles.glass}>
            <div style={styles.stationRow}>
              <div><strong>{currentName || "—"}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && (
              <div style={styles.compatBanner}>Compat CORS : traitement radio limité</div>
            )}
          </div>

          {/* Contrôles */}
          <div style={styles.controlsRow}>
            <div style={styles.switches}>
              <Switch label="MARCHE" on={marche} onChange={async v => { setMarche(v); v ? await powerOn() : powerOff(); }} />
              <Switch label="BALAYAGE AUTO" on={auto} onChange={(v) => setAuto(v)} />
              <Bouton label="SUIVANTE" onClick={async () => {
                const list = stationsRef.current;
                const next = (idxRef.current + 1) % list.length;
                await tuneTo(next);
              }} />
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
        Astuce : vérifie <code>/stations.json</code> dans ton navigateur — le badge doit afficher le bon total. Mets <strong>AUTO</strong> pour balayer toutes les stations.
      </p>
    </main>
  );
}

/* ——— UI widgets ——— */

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
        <div style={{ ...ui.switchDot, transform: `translateX(${on ? 32 : 0}px)` }} />
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

  rightHeader: { display: "flex", alignItems: "center", gap: 12 },
  badge: {
    fontSize: 12, color: "#0b0b10", background: "#f0c14b",
    border: "1px solid #2b2e3a", padding: "4px 8px", borderRadius: 10, fontWeight: 800
  },
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
  switch: { width: 64, height: 26, borderRadius: 16, position: "relative", border: "1px solid #2b2b36" },
  switchDot: { width: 24, height: 24, borderRadius: "50%", background: "#0b0b10", border: "1px solid #2b2b36", position: "absolute", top: 1, left: 1, transition: "transform .15s" },

  button: { cursor: "pointer", border: "1px solid #2b2b36", borderRadius: 12, padding: "10px 14px", fontWeight: 800, fontSize: 13, color: "#0b0b10", boxShadow: "0 6px 18px rgba(0,0,0,0.35)", background: "#5b4dd6" },

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
