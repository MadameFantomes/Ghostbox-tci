"use client";

/**
 * Ghostbox TCI — Radio Vintage (live)
 * - Vraies stations (HTTPS/CORS-friendly)
 * - POWER, TUNING, VOLUME, NOISE, FILTER (band-pass), AUTO SWEEP + vitesse
 * - Enregistrement .webm (MediaRecorder)
 * - VU-mètres animés (AnalyserNode)
 * - UI 100% CSS (bois, vitre, vis, cadran rétro)
 */

import React, { useEffect, useRef, useState } from "react";

// —————————————————— Stations (tu peux en ajouter) ——————————————————
const STATIONS = [
  { name: "RadioMast MP3", url: "https://streams.radiomast.io/reference-mp3" },
  { name: "RadioMast AAC", url: "https://streams.radiomast.io/reference-aac" },
  { name: "Swiss Jazz (96k)", url: "https://stream.srg-ssr.ch/srgssr/rsj/aac/96" },
  { name: "Swiss Classic (96k)", url: "https://stream.srg-ssr.ch/srgssr/rsc/aac/96" }
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

  // UI state
  const [power, setPower] = useState(false);
  const [stationIndex, setStationIndex] = useState(0);
  const [status, setStatus] = useState("prêt");

  const [volume, setVolume] = useState(0.9);
  const [noise, setNoise] = useState(0.25);
  const [filterOn, setFilterOn] = useState(true);
  const [q, setQ] = useState(1.2);
  const [fMin, setFMin] = useState(280);
  const [fMax] = useState(3800); // (affiché, range futur si tu veux balayer en continu)

  const [autoSweep, setAutoSweep] = useState(false);
  const [sweepSpeed, setSweepSpeed] = useState(0.45); // 0..1 (→ ms)
  const sweepTimerRef = useRef(null);

  // Recorder
  const [isRecording, setIsRecording] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);

  // VU meter level (0..1)
  const [vuL, setVuL] = useState(0);
  const [vuR, setVuR] = useState(0);

  // Helpers
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function msFromSpeed(v) { return Math.round(300 + v * (2000 - 300)); } // 300ms rapide → 2000ms lent

  // ——— Init
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

    // bandpass
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

    // analyser pour VU
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyserRef.current = analyser;

    // routing
    rechain(filterOn);
    // brancher le master AU-DESSUS de destination sur l'analyseur
    master.connect(analyser);
    startVuLoop();
  }

  function rechain(useFilter) {
    try { radioGainRef.current?.disconnect(); } catch {}
    try { noiseGainRef.current?.disconnect(); } catch {}
    try { bandpassRef.current?.disconnect(); } catch {}

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

  // ——— Power
  async function powerOn() {
    await initAudio();
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    try { noiseNodeRef.current.start(0); } catch {}
    await attachMedia();
    await tuneTo(stationIndex);
    setPower(true);
  }
  function powerOff() {
    stopSweepTimer();
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
      audioElRef.current.load();
    }
    setPower(false);
    setStatus("arrêté");
  }

  // ——— Tuning
  async function tuneTo(index) {
    if (!audioElRef.current) return;
    const el = audioElRef.current;
    const { url } = STATIONS[index];

    // petit fondu "scan"
    smooth(radioGainRef.current.gain, Math.max(0.12, volume * 0.25), 0.12);
    smooth(noiseGainRef.current.gain, Math.max(noise, 0.28), 0.12);

    el.pause(); el.src = url; setStatus("connexion…");
    try {
      await el.play();
      setStatus("lecture");
      smooth(radioGainRef.current.gain, volume, 0.28);
      smooth(noiseGainRef.current.gain, noise, 0.38);
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

  // ——— Auto sweep
  function startSweepTimer() {
    stopSweepTimer();
    const interval = msFromSpeed(sweepSpeed);
    sweepTimerRef.current = setInterval(() => {
      setStationIndex(prev => {
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

  // ——— Record
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

  // ——— React to UI changes
  useEffect(() => { if (radioGainRef.current) radioGainRef.current.gain.value = volume; }, [volume]);
  useEffect(() => { if (noiseGainRef.current)  noiseGainRef.current.gain.value  = noise; }, [noise]);
  useEffect(() => { if (bandpassRef.current)   bandpassRef.current.Q.value     = q; }, [q]);
  useEffect(() => { if (bandpassRef.current)   bandpassRef.current.frequency.value = Math.max(60, fMin); }, [fMin]);
  useEffect(() => { if (ctxRef.current) rechain(filterOn); }, [filterOn]);

  useEffect(() => {
    if (!autoSweep) { stopSweepTimer(); return; }
    startSweepTimer();
    return stopSweepTimer;
  }, [autoSweep, sweepSpeed, power]);

  // ——— VU meter loop
  function startVuLoop() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    function loop() {
      analyser.getByteTimeDomainData(data);
      // RMS approx
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length); // 0..~1
      const lvl = Math.min(1, rms * 1.8);
      // Joue un peu sur L/R pour l’esthétique
      setVuL(l => l * 0.7 + lvl * 0.3);
      setVuR(r => r * 0.7 + (lvl * 0.9) * 0.3);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // ——— UI computed
  const tuneValue = STATIONS.length > 1 ? stationIndex / (STATIONS.length - 1) : 0;

  return (
    <main style={styles.page}>
      <div style={styles.shadowWrap}>
        <div style={styles.cabinet}>
          {/* Plaque marque + lampes */}
          <div style={styles.headerBar}>
            <div style={styles.brandPlate}>
              <div style={styles.brandText}>MADAME FANTÔMES</div>
              <div style={styles.brandSub}>Ghostbox • TCI</div>
            </div>
            <div style={styles.lampsRow}>
              <Lamp label="POWER" on={power} />
              <Lamp label="REC" on={isRecording} colorOn="#ff5656" />
            </div>
          </div>

          {/* Vitre + cadran */}
          <div style={styles.glass}>
            <div style={styles.scaleWrap}>
              <div style={styles.scaleGrid} />
              {/* Ticks & labels */}
              {STATIONS.map((s, i) => (
                <div key={s.url} style={{ ...styles.tick, left: `${(i/(STATIONS.length-1))*100}%` }} />
              ))}
              <div style={{ ...styles.needle, left: `${tuneValue*100}%` }} />
            </div>
            <div style={styles.stationRow}>
              <div style={styles.stationLeft}>
                <strong>{STATIONS[stationIndex].name}</strong>
              </div>
              <div style={styles.stationRight}>
                <em style={{ opacity: 0.9 }}>{status}</em>
              </div>
            </div>
            {/* Micro-rayures */}
            <div style={styles.scratches} aria-hidden />
          </div>

          {/* Grille + VU meters */}
          <div style={styles.speakerSection}>
            <div style={styles.grill} />
            <div style={styles.vuWrap}>
              <VuMeter label="VU L" value={vuL} />
              <VuMeter label="VU R" value={vuR} />
            </div>
          </div>

          {/* Contrôles */}
          <div style={styles.controlsRow}>
            {/* Col. gauche */}
            <div style={styles.colLeft}>
              <ToggleSwitch
                label="POWER"
                on={power}
                onChange={async v => { setPower(v); v ? await powerOn() : powerOff(); }}
              />
              <ToggleSwitch label="FILTER" on={filterOn} onChange={setFilterOn} />
              <ToggleSwitch label="AUTO SWEEP" on={autoSweep} onChange={setAutoSweep} />
              <Knob label="SWEEP" value={sweepSpeed} onChange={v => setSweepSpeed(clamp01(v))} hint={`${msFromSpeed(sweepSpeed)} ms`} />
            </div>

            {/* Col. centre */}
            <div style={styles.colCenter}>
              <Knob label="VOLUME" value={volume} onChange={v => setVolume(clamp01(v))} />
              <Knob label="NOISE" value={noise} onChange={v => setNoise(clamp01(v))} />
              <Button label={isRecording ? "STOP" : "RECORD"} color={isRecording ? "#f0c14b" : "#d94242"} onClick={toggleRecord} />
            </div>

            {/* Col. droite */}
            <div style={styles.colRight}>
              <BigKnob
                label="TUNING"
                value={tuneValue}
                onChange={async v => {
                  const idx = Math.round(clamp01(v) * (STATIONS.length - 1));
                  setStationIndex(idx);
                  if (power) await tuneTo(idx);
                }}
              />
              <div style={styles.subDials}>
                <MiniDial label="Q" min={0.4} max={6} step={0.1} value={q} setValue={setQ} />
                <MiniDial label="fMin" min={60} max={2000} step={20} value={fMin} setValue={setFMin} />
                <Button label="NEXT" onClick={async () => {
                  const next = (stationIndex + 1) % STATIONS.length;
                  setStationIndex(next); if (power) await tuneTo(next);
                }} />
              </div>
            </div>
          </div>

          {/* Audio element */}
          <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
        </div>

        {/* Décor : vis */}
        <Screw at="tl" />
        <Screw at="tr" />
        <Screw at="bl" />
        <Screw at="br" />
      </div>

      <p style={{ color: "rgba(255,255,255,0.7)", marginTop: 14, fontSize: 12 }}>
        Conseil : clique d’abord <strong>POWER</strong>, puis joue avec <strong>TUNING</strong>, <strong>FILTER</strong> et <strong>NOISE</strong>.
      </p>
    </main>
  );
}

/* —————————————— UI widgets —————————————— */

function Knob({ label, value, onChange, hint }) {
  const [drag, setDrag] = useState(null);
  const angle = -135 + value * 270;
  return (
    <div style={ui.knobBlock}>
      <div
        style={{ ...ui.knob, transform: `rotate(${angle}deg)` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ y: e.clientY, v: value }); }}
        onPointerMove={(e) => { if (!drag) return; const delta = (drag.y - e.clientY) / 220; onChange(drag.v + delta); }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
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
        onPointerMove={(e) => {
          if (!drag) return;
          const dy = (drag.y - e.clientY) / 340;
          const dx = (e.clientX - drag.x) / 420;
          onChange(drag.v + dy + dx * 0.25);
        }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        <div style={ui.bigKnobIndicator} />
      </div>
      <div style={ui.knobLabel}>{label}</div>
    </div>
  );
}

function ToggleSwitch({ label, on, onChange }) {
  return (
    <div style={ui.switchBlock} onClick={() => onChange(!on)}>
      <div style={ui.switchLabel}>{label}</div>
      <div style={{ ...ui.switch, background: on ? "#6ad27a" : "#464a58" }}>
        <div style={{ ...ui.switchDot, transform: `translateX(${on ? 20 : 0}px)` }} />
      </div>
    </div>
  );
}

function Button({ label, onClick, color = "#5b4dd6" }) {
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

function VuMeter({ label, value }) {
  const pct = Math.round(clamp01(value) * 100);
  const color =
    pct < 60 ? "#7bdc8b" :
    pct < 85 ? "#f0c14b" :
    "#ff6a6a";
  return (
    <div style={vu.box}>
      <div style={vu.scale}>
        <div style={{ ...vu.bar, width: `${pct}%`, background: color }} />
      </div>
      <div style={vu.label}>{label}</div>
    </div>
  );
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
}

function Screw({ at }) {
  const pos = {
    tl: { top: -8, left: -8 },
    tr: { top: -8, right: -8 },
    bl: { bottom: -8, left: -8 },
    br: { bottom: -8, right: -8 }
  }[at];
  return <div style={{ ...decor.screw, ...pos }} />;
}

/* —————————————— Styles —————————————— */

const styles = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(1600px 700px at 50% -200px, #1a1920, #0b0b10 60%)",
    display: "grid",
    placeItems: "center",
    padding: 24
  },
  shadowWrap: { position: "relative" },
  cabinet: {
    width: "min(980px, 94vw)",
    borderRadius: 26,
    padding: 16,
    border: "1px solid rgba(30,20,10,0.6)",
    boxShadow:
      "0 28px 80px rgba(0,0,0,0.65), inset 0 0 0 1px rgba(255,255,255,0.03)",
    background:
      // bois texturé
      "linear-gradient(180deg,#4b3425,#3c2a1f 40%,#34241b 100%), " +
      "repeating-linear-gradient(45deg, rgba(255,255,255,0.05) 0 1px, rgba(0,0,0,0.06) 1px 2px)",
    position: "relative",
    overflow: "hidden"
  },

  headerBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12
  },
  brandPlate: {
    background: "linear-gradient(180deg,#2a2b30,#1b1c23)",
    color: "#e8e3d6",
    borderRadius: 10,
    border: "1px solid #2a2c36",
    padding: "8px 12px",
    boxShadow: "inset 0 0 18px rgba(0,0,0,0.45)"
  },
  brandText: { fontWeight: 800, letterSpacing: 2, fontSize: 13 },
  brandSub: { fontSize: 11, opacity: 0.75 },
  lampsRow: { display: "flex", gap: 14, alignItems: "center" },

  glass: {
    borderRadius: 16,
    border: "1px solid #2b2e3a",
    background:
      "linear-gradient(180deg, rgba(16,18,26,0.95), rgba(10,12,18,0.95)), " +
      "radial-gradient(800px 200px at 50% -80px, rgba(255,255,255,0.06), transparent 60%)",
    padding: 12,
    position: "relative",
    overflow: "hidden",
    boxShadow: "inset 0 0 28px rgba(0,0,0,0.5)"
  },
  scaleWrap: {
    position: "relative",
    height: 54,
    borderRadius: 10,
    border: "1px solid #252834",
    background: "#0d0f15",
    overflow: "hidden",
    marginBottom: 8
  },
  scaleGrid: {
    position: "absolute",
    inset: 0,
    background:
      "repeating-linear-gradient(90deg, rgba(255,255,255,0.08) 0 2px, transparent 2px 12px)"
  },
  tick: {
    position: "absolute", top: 0, width: 2, height: "100%",
    background: "rgba(240,210,140,0.7)", transform: "translateX(-1px)"
  },
  needle: {
    position: "absolute", top: 0, width: 2, height: "100%",
    background: "#f05a6e",
    boxShadow: "0 0 10px rgba(240,90,110,0.7), 0 0 20px rgba(240,90,110,0.35)",
    transform: "translateX(-1px)"
  },
  stationRow: {
    display: "flex", justifyContent: "space-between",
    color: "#eae7f5", fontSize: 13, padding: "0 2px"
  },
  scratches: {
    position: "absolute", inset: 0, pointerEvents: "none",
    background:
      "linear-gradient(transparent, rgba(255,255,255,0.03) 20%, transparent 60%), " +
      "repeating-linear-gradient(120deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 4px)"
  },

  speakerSection: {
    marginTop: 12,
    display: "grid",
    gridTemplateColumns: "2fr 1fr",
    gap: 12
  },
  grill: {
    borderRadius: 14,
    border: "1px solid #282a32",
    height: 120,
    background:
      "radial-gradient(circle at 30% 30%, rgba(0,0,0,0.3), transparent 65%), " +
      "repeating-linear-gradient(45deg, #1a1d27 0 6px, #131521 6px 12px)"
  },
  vuWrap: {
    borderRadius: 14,
    border: "1px solid #282a32",
    height: 120,
    padding: 12,
    background:
      "linear-gradient(180deg,#12141c,#0e1017)",
    display: "grid",
    gridTemplateRows: "1fr 1fr",
    gap: 10
  },

  controlsRow: {
    marginTop: 14,
    display: "grid",
    gridTemplateColumns: "1.05fr 1fr 1.05fr",
    gap: 14
  },
  colLeft: {
    display: "grid", gridTemplateRows: "auto auto auto auto", gap: 10, alignContent: "start"
  },
  colCenter: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
    alignItems: "center",
    justifyItems: "center"
  },
  colRight: {
    display: "grid", gridTemplateRows: "auto auto", gap: 10, justifyItems: "center", alignContent: "start"
  },
  subDials: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "center" }
};

const ui = {
  knobBlock: { display: "grid", justifyItems: "center" },
  knob: {
    width: 86, height: 86, borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, #4d505a, #2a2f3a 60%, #141821 100%)",
    border: "1px solid #1e2430",
    boxShadow: "inset 0 10px 26px rgba(0,0,0,0.6), 0 8px 24px rgba(0,0,0,0.45)",
    display: "grid", placeItems: "center",
    touchAction: "none", userSelect: "none", cursor: "grab",
    transition: "transform .05s linear"
  },
  knobIndicator: {
    width: 6, height: 26, borderRadius: 3, background: "#f6d8a8",
    boxShadow: "0 0 8px rgba(246,216,168,0.4)"
  },
  knobLabel: { color: "#f0e7d1", marginTop: 6, fontSize: 12, letterSpacing: 1.2 },
  hint: { color: "rgba(255,255,255,0.65)", fontSize: 11, marginTop: 2 },

  bigKnobBlock: { display: "grid", justifyItems: "center" },
  bigKnob: {
    width: 148, height: 148, borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, #5a5e68, #2a2f3a 60%, #141821 100%)",
    border: "1px solid #1e2430",
    boxShadow: "inset 0 12px 30px rgba(0,0,0,0.62), 0 10px 28px rgba(0,0,0,0.5)",
    display: "grid", placeItems: "center",
    touchAction: "none", userSelect: "none", cursor: "grab"
  },
  bigKnobIndicator: {
    width: 8, height: 34, borderRadius: 4, background: "#ffd28c",
    boxShadow: "0 0 12px rgba(255,210,140,0.55)"
  },

  switchBlock: { display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 10 },
  switchLabel: { color: "#f0e7d1", fontSize: 12, letterSpacing: 1.2 },
  switch: { width: 44, height: 20, borderRadius: 12, position: "relative", border: "1px solid #2b2b36" },
  switchDot: { width: 18, height: 18, borderRadius: "50%", background: "#0b0b10", border: "1px solid #2b2b36", position: "absolute", top: 1, left: 1, transition: "transform .15s" },

  button: {
    cursor: "pointer",
    border: "1px solid #2b2b36",
    borderRadius: 12,
    padding: "10px 14px",
    fontWeight: 800,
    fontSize: 13,
    color: "#0b0b10",
    boxShadow: "0 6px 18px rgba(0,0,0,0.35)"
  },

  lamp: { display: "grid", gridTemplateColumns: "auto auto", gap: 6, alignItems: "center" },
  lampDot: { width: 12, height: 12, borderRadius: "50%" },
  lampLabel: { color: "#e0d8c0", fontSize: 11, letterSpacing: 1 },

  miniDial: { display: "grid", gridTemplateRows: "auto auto auto", gap: 4, alignItems: "center" },
  miniLabel: { color: "#f0e7d1", fontSize: 11, letterSpacing: 1.2, textAlign: "center" },
  miniVal: { color: "rgba(255,255,255,0.8)", fontSize: 11, textAlign: "center" }
};

const vu = {
  box: {
    background: "linear-gradient(180deg,#171923,#0f121a)",
    border: "1px solid #262a36",
    borderRadius: 10,
    padding: 8,
    boxShadow: "inset 0 0 22px rgba(0,0,0,0.5)",
    display: "grid",
    gridTemplateRows: "1fr auto",
    gap: 6
  },
  scale: {
    height: 12,
    borderRadius: 8,
    background: "linear-gradient(180deg,#0b0e15,#0a0c12)",
    border: "1px solid #242837",
    overflow: "hidden",
    position: "relative"
  },
  bar: {
    position: "absolute", top: 0, left: 0, bottom: 0,
    background: "#7bdc8b", transition: "width 60ms linear"
  },
  label: { color: "#cfc8b0", fontSize: 10, textAlign: "right", opacity: 0.85 }
};

const decor = {
  screw: {
    position: "absolute",
    width: 18, height: 18,
    borderRadius: "50%",
    background:
      "radial-gradient(circle at 30% 30%, #9aa0ad, #4b515e 60%, #1e232d)",
    border: "1px solid #222834",
    boxShadow: "0 8px 20px rgba(0,0,0,0.5), inset 0 3px 8px rgba(0,0,0,0.6)"
  }
};
