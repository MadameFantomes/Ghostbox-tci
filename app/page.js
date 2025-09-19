"use client";

/**
 * Ghostbox TCI — Radio vintage UI (live radio + WebAudio)
 * Contrôles:
 *  - POWER (on/off) : démarre/arrête l'audio
 *  - TUNING (gros bouton à droite) : change de station
 *  - VOLUME : niveau de la radio
 *  - NOISE : niveau du bruit blanc
 *  - FILTER (switch) : active/désactive band-pass
 *  - AUTO SWEEP (switch) : saute de station automatiquement
 *  - SWEEP SPEED : vitesse de balayage entre stations
 *  - RECORD (bouton rouge) : enregistre en .webm
 *
 * Astuce: un premier clic sur POWER suffit à “débloquer” l’audio (politique navigateur).
 */

import React, { useEffect, useRef, useState } from "react";

// ————————————————————— Stations test (HTTPS + CORS-friendly) —————————————————————
const STATIONS = [
  { name: "RadioMast Reference MP3", url: "https://streams.radiomast.io/reference-mp3" },
  { name: "RadioMast Reference AAC", url: "https://streams.radiomast.io/reference-aac" },
  { name: "Radio Swiss Jazz (96k AAC)", url: "https://stream.srg-ssr.ch/srgssr/rsj/aac/96" },
  { name: "Radio Swiss Classic (96k AAC)", url: "https://stream.srg-ssr.ch/srgssr/rsc/aac/96" }
];

// ————————————————————— Composant principal —————————————————————
export default function Page() {
  const audioElRef = useRef(null);

  // Audio graph
  const ctxRef = useRef(null);
  const destRef = useRef(null);
  const masterGainRef = useRef(null);
  const mediaSrcRef = useRef(null);
  const radioGainRef = useRef(null);
  const noiseNodeRef = useRef(null);
  const noiseGainRef = useRef(null);
  const bandpassRef = useRef(null);

  // État UI
  const [power, setPower] = useState(false);
  const [stationIndex, setStationIndex] = useState(0);
  const [status, setStatus] = useState("prêt");

  const [volume, setVolume] = useState(0.9);      // 0..1
  const [noise, setNoise] = useState(0.25);       // 0..1
  const [filterOn, setFilterOn] = useState(true);
  const [q, setQ] = useState(1.0);
  const [fMin, setFMin] = useState(250);
  const [fMax, setFMax] = useState(3500);

  const [autoSweep, setAutoSweep] = useState(false);
  const [sweepSpeed, setSweepSpeed] = useState(0.4); // 0..1 ⇒ 300..2000 ms
  const sweepTimerRef = useRef(null);

  // Recording
  const [isRecording, setIsRecording] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);

  // ——— Helpers ———
  function msFromSpeed(v) {
    // 0 → 300ms (rapide), 1 → 2000ms (lent)
    return Math.round(300 + v * (2000 - 300));
  }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  // ——— Init WebAudio ———
  async function initAudio() {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxRef.current = ctx;

    // master
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    masterGainRef.current = master;

    // enregistrement
    const dest = ctx.createMediaStreamDestination();
    master.connect(dest);
    destRef.current = dest;

    // band-pass
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = q;
    band.frequency.value = fMin;
    bandpassRef.current = band;

    // gains
    const gRadio = ctx.createGain(); gRadio.gain.value = volume; radioGainRef.current = gRadio;
    const gNoise = ctx.createGain(); gNoise.gain.value = noise;  noiseGainRef.current = gNoise;

    // bruit blanc
    const n = createNoiseNode(ctx); noiseNodeRef.current = n;

    // routing initial
    rechain(filterOn);
  }

  function rechain(useFilter) {
    try { radioGainRef.current.disconnect(); } catch {}
    try { noiseGainRef.current.disconnect(); } catch {}
    try { bandpassRef.current.disconnect(); } catch {}

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
    if (!ctxRef.current || !audioElRef.current) return;
    if (mediaSrcRef.current) {
      try { mediaSrcRef.current.disconnect(); } catch {}
      mediaSrcRef.current = null;
    }
    const src = ctxRef.current.createMediaElementSource(audioElRef.current);
    mediaSrcRef.current = src;
    src.connect(radioGainRef.current);
  }

  // ——— Power ———
  async function powerOn() {
    await initAudio();
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") await ctx.resume();

    // démarre bruit (idempotent)
    try { noiseNodeRef.current.start(0); } catch {}

    await attachMedia();
    await tuneTo(stationIndex);
    setPower(true);
  }

  function powerOff() {
    stopSweepTimer();
    // stop lecture
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
      audioElRef.current.load();
    }
    setPower(false);
    setStatus("arrêté");
  }

  // ——— Tuning / lecture ———
  async function tuneTo(index) {
    if (!audioElRef.current) return;
    const el = audioElRef.current;
    const { url } = STATIONS[index];

    // petit fondu (radio down, noise up)
    smooth(radioGainRef.current.gain, Math.max(0.12, volume * 0.25), 0.1);
    smooth(noiseGainRef.current.gain, Math.max(noise, 0.25), 0.1);

    el.pause();
    el.src = url;
    setStatus("connexion…");
    try {
      await el.play();
      setStatus("lecture");
      // remonte radio, redescend bruit
      smooth(radioGainRef.current.gain, volume, 0.25);
      smooth(noiseGainRef.current.gain, noise, 0.35);
    } catch {
      setStatus("échec (CORS/format)");
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

  // ——— Sweep auto ———
  function startSweepTimer() {
    stopSweepTimer();
    const interval = msFromSpeed(sweepSpeed);
    sweepTimerRef.current = setInterval(() => {
      setStationIndex((prev) => {
        const next = (prev + 1) % STATIONS.length;
        if (power) tuneTo(next);
        return next;
      });
    }, interval);
  }
  function stopSweepTimer() {
    if (sweepTimerRef.current) clearInterval(sweepTimerRef.current);
    sweepTimerRef.current = null;
  }

  // ——— Recording ———
  function toggleRecord() {
    if (!destRef.current) return;
    if (!isRecording) {
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
      rec.start(); recRef.current = rec; setIsRecording(true);
    } else {
      recRef.current?.stop(); setIsRecording(false);
    }
  }

  // ——— Réactions UI → Audio ———
  useEffect(() => { if (radioGainRef.current) radioGainRef.current.gain.value = volume; }, [volume]);
  useEffect(() => { if (noiseGainRef.current)  noiseGainRef.current.gain.value  = noise; }, [noise]);
  useEffect(() => { if (bandpassRef.current)   bandpassRef.current.Q.value     = q; }, [q]);
  useEffect(() => { if (bandpassRef.current)   bandpassRef.current.frequency.value = Math.max(60, fMin); }, [fMin]);
  useEffect(() => { /* fMax est utilisé si on veut animer la freq de fMin→fMax ; pour l’instant on l’affiche */ }, [fMax]);
  useEffect(() => { if (ctxRef.current) rechain(filterOn); }, [filterOn]);

  useEffect(() => {
    if (!autoSweep) { stopSweepTimer(); return; }
    startSweepTimer();
    return stopSweepTimer;
  }, [autoSweep, sweepSpeed, power]);

  // ——— UI Vintage ———
  const tuneValue = STATIONS.length > 1 ? stationIndex / (STATIONS.length - 1) : 0;

  return (
    <main style={styles.page}>
      <div style={styles.radioBox}>
        {/* Tête de radio : marque + cadran */}
        <div style={styles.brandRow}>
          <div style={styles.brand}>MADAME FANTÔMES</div>
          <div style={styles.lamps}>
            <Lamp label="POWER" on={power} />
            <Lamp label="REC" on={isRecording} colorOn="#ff5050" />
          </div>
        </div>

        <div style={styles.display}>
          <div style={styles.scale}>
            {STATIONS.map((s, i) => (
              <div key={s.url} style={{ ...styles.tick, left: `${(i/(STATIONS.length-1))*100}%` }} />
            ))}
            <div style={{ ...styles.needle, left: `${tuneValue*100}%` }} />
          </div>
          <div style={styles.stationText}>
            <strong>{STATIONS[stationIndex].name}</strong>
            <span style={{ opacity: 0.8, marginLeft: 8 }}>— {status}</span>
          </div>
        </div>

        {/* Grille haut-parleur */}
        <div style={styles.grille} aria-hidden />

        {/* Boutons / Contrôles */}
        <div style={styles.controlsRow}>

          {/* Colonne gauche : Power + Filter + AutoSweep */}
          <div style={styles.leftColumn}>
            <ToggleSwitch
              label="POWER"
              on={power}
              onChange={async (v) => { setPower(v); v ? await powerOn() : powerOff(); }}
            />
            <ToggleSwitch
              label="FILTER"
              on={filterOn}
              onChange={(v) => setFilterOn(v)}
            />
            <ToggleSwitch
              label="AUTO SWEEP"
              on={autoSweep}
              onChange={(v) => setAutoSweep(v)}
            />

            <Knob
              label={`SWEEP SPEED`}
              value={sweepSpeed}
              onChange={(v) => setSweepSpeed(clamp01(v))}
              hint={`${msFromSpeed(sweepSpeed)} ms`}
            />
          </div>

          {/* Centre : deux knobs (VOLUME / NOISE) + bouton REC */}
          <div style={styles.centerColumn}>
            <Knob
              label={`VOLUME`}
              value={volume}
              onChange={(v) => setVolume(clamp01(v))}
            />
            <Knob
              label={`NOISE`}
              value={noise}
              onChange={(v) => setNoise(clamp01(v))}
            />
            <Button
              label={isRecording ? "STOP" : "RECORD"}
              color={isRecording ? "#f0c14b" : "#d94242"}
              onClick={toggleRecord}
            />
          </div>

          {/* Droite : gros TUNING + params filtre fins */}
          <div style={styles.rightColumn}>
            <BigKnob
              label="TUNING"
              value={tuneValue}
              onChange={async (v) => {
                const idx = Math.round(clamp01(v) * (STATIONS.length - 1));
                setStationIndex(idx);
                if (power) await tuneTo(idx);
              }}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
              <MiniDial label="Q" min={0.4} max={6} step={0.1} value={q} setValue={setQ} />
              <MiniDial label="fMin" min={60} max={2000} step={20} value={fMin} setValue={setFMin} />
              <MiniDial label="fMax" min={500} max={8000} step={50} value={fMax} setValue={setFMax} />
              <Button
                label="NEXT"
                onClick={async () => {
                  const next = (stationIndex + 1) % STATIONS.length;
                  setStationIndex(next);
                  if (power) await tuneTo(next);
                }}
              />
            </div>
          </div>
        </div>

        {/* Élément audio caché */}
        <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
      </div>

      <p style={{ color: "rgba(255,255,255,0.6)", marginTop: 14, fontSize: 12 }}>
        Astuce : clique d’abord POWER, puis tourne les boutons. Tu peux activer <strong>AUTO SWEEP</strong> et régler <strong>SWEEP SPEED</strong>.
      </p>
    </main>
  );
}

// ————————————————————— Composants UI —————————————————————

function Knob({ label, value, onChange, hint }) {
  const [drag, setDrag] = useState(null);
  const angle = -135 + value * 270; // de -135° à +135°

  return (
    <div style={styles.knobBlock}>
      <div
        style={{
          ...styles.knob,
          transform: `rotate(${angle}deg)`,
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ startY: e.clientY, start: value });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const delta = (drag.startY - e.clientY) / 200; // sensibilité
          onChange(drag.start + delta);
        }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        aria-label={label}
      >
        <div style={styles.knobIndicator} />
      </div>
      <div style={styles.knobLabel}>{label}</div>
      {hint && <div style={styles.hint}>{hint}</div>}
    </div>
  );
}

function BigKnob({ label, value, onChange }) {
  const [drag, setDrag] = useState(null);
  const angle = -135 + value * 270;
  return (
    <div style={styles.bigKnobBlock}>
      <div
        style={{
          ...styles.bigKnob,
          transform: `rotate(${angle}deg)`,
        }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ startX: e.clientX, startY: e.clientY, start: value }); }}
        onPointerMove={(e) => {
          if (!drag) return;
          const dy = (drag.startY - e.clientY) / 300;
          const dx = (e.clientX - drag.startX) / 300;
          onChange(drag.start + dy + dx * 0.2); // un peu horizontal
        }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        <div style={styles.bigKnobIndicator} />
      </div>
      <div style={styles.knobLabel}>{label}</div>
    </div>
  );
}

function ToggleSwitch({ label, on, onChange }) {
  return (
    <div style={styles.switchBlock} onClick={() => onChange(!on)}>
      <div style={styles.switchLabel}>{label}</div>
      <div style={{ ...styles.switch, background: on ? "#6ccf7a" : "#444654" }}>
        <div style={{ ...styles.switchDot, transform: `translateX(${on ? 20 : 0}px)` }} />
      </div>
    </div>
  );
}

function Button({ label, onClick, color = "#5b4dd6" }) {
  return (
    <button onClick={onClick} style={{ ...styles.button, background: color }}>{label}</button>
  );
}

function Lamp({ label, on, colorOn = "#86fb6a" }) {
  return (
    <div style={styles.lamp}>
      <div style={{ ...styles.lampDot, background: on ? colorOn : "#222" }} />
      <div style={styles.lampLabel}>{label}</div>
    </div>
  );
}

function MiniDial({ label, min, max, step, value, setValue }) {
  return (
    <div style={styles.miniDial}>
      <div style={styles.miniLabel}>{label}</div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        style={{ width: "100%" }}
      />
      <div style={styles.miniVal}>{Math.round(value)}</div>
    </div>
  );
}

// ————————————————————— Styles —————————————————————

const styles = {
  page: {
    minHeight: "100vh",
    background: "radial-gradient(1200px 600px at 50% -200px, #1c1a22, #0b0b10 60%)",
    display: "grid",
    placeItems: "center",
    padding: 24
  },
  radioBox: {
    width: "min(980px, 96vw)",
    borderRadius: 22,
    padding: 18,
    border: "1px solid #2b2b36",
    boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
    background: "linear-gradient(180deg,#3a2f27,#2c231d)",
    position: "relative"
  },
  brandRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8
  },
  brand: {
    color: "#f0e7d1",
    letterSpacing: 2,
    fontWeight: 700,
    fontSize: 14
  },
  lamps: { display: "flex", gap: 12, alignItems: "center" },

  display: {
    background: "linear-gradient(180deg,#0d0f16,#07080d)",
    border: "1px solid #232533",
    borderRadius: 14,
    padding: "12px 14px",
    color: "#eae7f5",
    boxShadow: "inset 0 0 30px rgba(0,0,0,0.45)"
  },
  scale: {
    height: 32,
    position: "relative",
    background: "repeating-linear-gradient(90deg, rgba(255,255,255,0.08) 0px, rgba(255,255,255,0.08) 2px, transparent 2px, transparent 8px)",
    borderRadius: 8,
    marginBottom: 8,
    overflow: "hidden"
  },
  tick: {
    position: "absolute",
    top: 0,
    width: 2,
    height: "100%",
    background: "rgba(255,255,255,0.35)",
    transform: "translateX(-1px)"
  },
  needle: {
    position: "absolute",
    top: 0,
    width: 2,
    height: "100%",
    background: "#f05a6e",
    boxShadow: "0 0 8px rgba(240,90,110,0.6)",
    transform: "translateX(-1px)"
  },
  stationText: { fontSize: 13, opacity: 0.9 },

  grille: {
    marginTop: 12,
    height: 90,
    borderRadius: 12,
    border: "1px solid #2b2b36",
    background:
      "radial-gradient(circle at 20% 50%, rgba(0,0,0,0.4), transparent 60%), " +
      "repeating-linear-gradient(45deg, #1c1e27 0, #1c1e27 3px, #151722 3px, #151722 6px)"
  },

  controlsRow: {
    display: "grid",
    gridTemplateColumns: "1.1fr 1fr 1.1fr",
    gap: 16,
    marginTop: 16
  },

  leftColumn: {
    display: "grid",
    gridTemplateRows: "auto auto auto auto",
    gap: 10,
    alignContent: "start"
  },
  centerColumn: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
    alignItems: "center",
    justifyItems: "center"
  },
  rightColumn: {
    display: "grid",
    gridTemplateRows: "auto auto",
    gap: 6,
    alignContent: "start",
    justifyItems: "center"
  },

  // Knobs
  knobBlock: { display: "grid", justifyItems: "center" },
  knob: {
    width: 84, height: 84, borderRadius: "50%",
    background:
      "radial-gradient(circle at 30% 30%, #444, #262b34 60%, #141821 100%)",
    border: "1px solid #222834",
    boxShadow: "inset 0 8px 24px rgba(0,0,0,0.55), 0 6px 18px rgba(0,0,0,0.35)",
    display: "grid", placeItems: "center", transition: "transform 0.05s linear",
    touchAction: "none", userSelect: "none", cursor: "grab"
  },
  knobIndicator: {
    width: 6, height: 28, borderRadius: 3, background: "#eae7f5",
    boxShadow: "0 0 8px rgba(255,255,255,0.35)"
  },
  knobLabel: { color: "#f0e7d1", marginTop: 6, fontSize: 12, letterSpacing: 1.2 },
  hint: { color: "rgba(255,255,255,0.65)", fontSize: 11, marginTop: 2 },

  bigKnobBlock: { display: "grid", justifyItems: "center" },
  bigKnob: {
    width: 140, height: 140, borderRadius: "50%",
    background:
      "radial-gradient(circle at 30% 30%, #51535c, #2a2f3a 60%, #141821 100%)",
    border: "1px solid #222834",
    boxShadow: "inset 0 10px 28px rgba(0,0,0,0.6), 0 8px 22px rgba(0,0,0,0.45)",
    display: "grid", placeItems: "center", transition: "transform 0.05s linear",
    touchAction: "none", userSelect: "none", cursor: "grab"
  },
  bigKnobIndicator: {
    width: 8, height: 34, borderRadius: 4, background: "#ffd28c",
    boxShadow: "0 0 10px rgba(255,210,140,0.5)"
  },

  // Switch
  switchBlock: { display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 10 },
  switchLabel: { color: "#f0e7d1", fontSize: 12, letterSpacing: 1.2 },
  switch: { width: 44, height: 20, borderRadius: 12, position: "relative", border: "1px solid #2b2b36" },
  switchDot: {
    width: 18, height: 18, borderRadius: "50%", background: "#0b0b10",
    border: "1px solid #2b2b36", position: "absolute", top: 1, left: 1, transition: "transform .15s"
  },

  // Buttons
  button: {
    cursor: "pointer",
    border: "1px solid #2b2b36",
    borderRadius: 12,
    padding: "10px 14px",
    fontWeight: 700,
    fontSize: 13,
    color: "#0b0b10",
    boxShadow: "0 6px 18px rgba(0,0,0,0.35)"
  },

  // Lamps
  lamp: { display: "grid", gridTemplateColumns: "auto auto", gap: 6, alignItems: "center" },
  lampDot: { width: 12, height: 12, borderRadius: "50%", boxShadow: "0 0 8px rgba(0,0,0,0.4)" },
  lampLabel: { color: "#cfc8b0", fontSize: 11, letterSpacing: 1 }
};
