"use client";

/**
 * Ghostbox TCI — Radio Vintage (FR) • Inspiré des idées Vocibus Mk2
 * - Banques A/B de stations (FIP/Radio France + Radio Swiss)
 * - Balayage auto avec JITTER (aléa) pour casser le rythme
 * - Effets: ÉCHO (temps/retour), RÉVERB (taille/mix)
 * - Mode compatibilité CORS (si le flux bloque WebAudio)
 * - VU-mètres, enregistrement .webm
 * - Fond SVG aquarelle: /radio-vintage.svg
 */

import React, { useEffect, useRef, useState } from "react";

/* ————— Banques de stations —————
   Chaque station peut avoir plusieurs URLs (fallback MP3/AAC).
   Les flux Radio France documentés: icecast.radiofrance.fr (MP3/ACC) */
const BANKS = {
  A: [
    { name: "FIP", urls: [
      "https://icecast.radiofrance.fr/fip-midfi.mp3?id=radiofrance",
      "https://icecast.radiofrance.fr/fip-hifi.aac?id=radiofrance"
    ]},
    { name: "FIP Rock", urls: [
      "https://icecast.radiofrance.fr/fiprock-midfi.mp3?id=radiofrance",
      "https://icecast.radiofrance.fr/fiprock-hifi.aac?id=radiofrance"
    ]},
    { name: "FIP Jazz", urls: [
      "https://icecast.radiofrance.fr/fipjazz-midfi.mp3?id=radiofrance",
      "https://icecast.radiofrance.fr/fipjazz-hifi.aac?id=radiofrance"
    ]},
    { name: "Radio Swiss Jazz", urls: [
      "https://stream.srg-ssr.ch/srgssr/rsj/aac/96"
    ]}
  ],
  B: [
    { name: "France Inter", urls: [
      "https://icecast.radiofrance.fr/franceinter-midfi.mp3?id=radiofrance"
    ]},
    { name: "FIP Groove", urls: [
      "https://icecast.radiofrance.fr/fipgroove-midfi.mp3?id=radiofrance",
      "https://icecast.radiofrance.fr/fipgroove-hifi.aac?id=radiofrance"
    ]},
    { name: "FIP World", urls: [
      "https://icecast.radiofrance.fr/fipworld-midfi.mp3?id=radiofrance",
      "https://icecast.radiofrance.fr/fipworld-hifi.aac?id=radiofrance"
    ]},
    { name: "Radio Swiss Classic", urls: [
      "https://stream.srg-ssr.ch/srgssr/rsc/aac/96"
    ]}
  ]
};

export default function Page() {
  const audioElRef = useRef(null);

  // WebAudio
  const ctxRef = useRef(null);
  const destRef = useRef(null);
  const masterGainRef = useRef(null);

  // Sommes & traitement
  const preBusRef = useRef(null);       // somme radio + bruit
  const bandpassRef = useRef(null);     // filtre
  const dryGainRef = useRef(null);      // voie directe
  const echoDelayRef = useRef(null);    // ÉCHO
  const echoFbRef = useRef(null);
  const echoWetRef = useRef(null);
  const reverbConvolverRef = useRef(null); // RÉVERB
  const reverbWetRef = useRef(null);

  const mediaSrcRef = useRef(null);
  const radioGainRef = useRef(null);
  const noiseNodeRef = useRef(null);
  const noiseGainRef = useRef(null);

  const analyserRef = useRef(null);

  // UI
  const [bank, setBank] = useState("A"); // "A" | "B"
  const [stationIndex, setStationIndex] = useState(0);
  const [marche, setMarche] = useState(false);
  const [etat, setEtat] = useState("prêt");

  const [volume, setVolume] = useState(0.9);   // radio
  const [bruit, setBruit]   = useState(0.25);  // bruit blanc
  const [filtre, setFiltre] = useState(true);
  const [q, setQ] = useState(1.2);
  const [fMin, setFMin] = useState(280);

  // Balayage
  const [autoSweep, setAutoSweep] = useState(false);
  const [vitesse, setVitesse] = useState(0.45); // 0..1 -> 300..2000ms
  const [alea, setAlea] = useState(0.25);       // 0..0.6 => jitter ±%
  const sweepTimerRef = useRef(null);

  // Compat CORS
  const [compat, setCompat] = useState(false);

  // FX
  const [echoOn, setEchoOn] = useState(false);
  const [echoTime, setEchoTime] = useState(0.35);     // 0..1 => 80..800ms
  const [echoFb, setEchoFb] = useState(0.35);         // 0..1 => 0..0.85

  const [revOn, setRevOn] = useState(false);
  const [revSize, setRevSize] = useState(0.45);       // 0..1 => 0.2..2.5s
  const [revMix, setRevMix] = useState(0.35);         // 0..1 wet gain

  // Enregistrement
  const [enr, setEnr] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);

  // VU
  const [vuG, setVuG] = useState(0);
  const [vuD, setVuD] = useState(0);

  // Helpers
  const stations = BANKS[bank];
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const msFromSpeed = (v) => Math.round(300 + v * (2000 - 300));
  const msEcho = (v) => 0.08 + v * (0.80 - 0.08); // 80..800ms
  const fbEcho = (v) => Math.min(0.85, v * 0.85);
  const secRev = (v) => 0.2 + v * (2.5 - 0.2);   // 0.2..2.5s

  /* ————— Initialisation ————— */
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

    // somme entrée
    const pre = ctx.createGain(); pre.gain.value = 1; preBusRef.current = pre;

    // filtre
    const band = ctx.createBiquadFilter();
    band.type = "bandpass"; band.Q.value = q; band.frequency.value = fMin;
    bandpassRef.current = band;

    // voie directe
    const dry = ctx.createGain(); dry.gain.value = 1; dryGainRef.current = dry;

    // ÉCHO (chemin parallèle)
    const dly = ctx.createDelay(2.0); dly.delayTime.value = msEcho(echoTime);
    const fb  = ctx.createGain(); fb.gain.value = fbEcho(echoFb);
    dly.connect(fb); fb.connect(dly);      // boucle de feedback
    const echoWet = ctx.createGain(); echoWet.gain.value = 0; // activée via setEchoOn
    echoDelayRef.current = dly; echoFbRef.current = fb; echoWetRef.current = echoWet;

    // RÉVERB (chemin parallèle)
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = makeImpulseResponse(ctx, secRev(revSize), 2.5);
    const revWet = ctx.createGain(); revWet.gain.value = 0; // activée via setRevOn
    reverbConvolverRef.current = conv; reverbWetRef.current = revWet;

    // gains radio/bruit
    const gRadio = ctx.createGain(); gRadio.gain.value = volume; radioGainRef.current = gRadio;
    const gNoise = ctx.createGain(); gNoise.gain.value = bruit;  noiseGainRef.current = gNoise;

    // bruit blanc
    const noise = createNoiseNode(ctx); noiseNodeRef.current = noise;

    // analyser
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512; analyserRef.current = analyser;

    // Routing initial
    rebuildChain({ compatMode: false });

    // analyser branché sur master
    master.connect(analyser);
    startVuLoop();
  }

  function rebuildChain({ compatMode }) {
    const master = masterGainRef.current;
    const pre = preBusRef.current;
    const band = bandpassRef.current;
    const dry = dryGainRef.current;
    const dly = echoDelayRef.current, echoWet = echoWetRef.current;
    const conv = reverbConvolverRef.current, revWet = reverbWetRef.current;

    // clean
    [pre, band, dry, dly, echoWet, conv, revWet].forEach(n => { try { n.disconnect(); } catch {} });

    // Entrées vers preBus
    try { radioGainRef.current.disconnect(); } catch {}
    try { noiseGainRef.current.disconnect(); } catch {}
    noiseGainRef.current.connect(pre);
    if (!compatMode) radioGainRef.current.connect(pre);

    // Sélection de l’entrée chaîne
    const chainIn = filtre && !compatMode ? band : pre;
    if (filtre && !compatMode) pre.connect(band);

    // Branches
    chainIn.connect(dry);       dry.connect(master);          // direct
    chainIn.connect(dly);       dly.connect(echoWet);         echoWet.connect(master); // écho
    chainIn.connect(conv);      conv.connect(revWet);         revWet.connect(master);  // réverb

    // FX states
    echoWet.gain.value = echoOn ? 0.8 : 0.0;
    dly.delayTime.value = msEcho(echoTime);
    echoFbRef.current.gain.value = fbEcho(echoFb);

    reverbWetRef.current.gain.value = revOn ? revMix : 0.0;
    reverbConvolverRef.current.buffer = makeImpulseResponse(ctxRef.current, secRev(revSize), 2.5);
  }

  function createNoiseNode(ctx) {
    const size = 2 * ctx.sampleRate;
    const buf = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * 0.9;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    return src;
  }

  // Impulse pour réverb (bruit décay exponentiel)
  function makeImpulseResponse(ctx, seconds = 1.5, decay = 2.0) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  async function attachMedia() {
    if (!ctxRef.current || !audioElRef.current) return;
    if (mediaSrcRef.current) return; // déjà branché
    try {
      const src = ctxRef.current.createMediaElementSource(audioElRef.current);
      mediaSrcRef.current = src;
      src.connect(radioGainRef.current);
      setCompat(false);
      rebuildChain({ compatMode: false });
    } catch {
      // CORS bloqué
      setCompat(true);
      rebuildChain({ compatMode: true });
    }
  }

  /* ————— MARCHE ————— */
  async function marcheOn() {
    await initAudio();
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    try { noiseNodeRef.current.start(0); } catch {}
    await tuneTo(stationIndex); // lire d’abord
    setMarche(true);
  }
  function marcheOff() {
    stopSweep();
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
      audioElRef.current.load();
    }
    setMarche(false);
    setEtat("arrêté");
  }

  /* ————— Tuning ————— */
  async function tuneTo(index) {
    const el = audioElRef.current; if (!el) return;
    const { urls } = stations[index];

    // petit fondu “scan”
    smooth(noiseGainRef.current.gain, Math.max(bruit, 0.28), 0.12);
    if (!compat) smooth(radioGainRef.current.gain, Math.max(0.12, volume * 0.25), 0.12);

    setEtat(`connexion…`);
    el.crossOrigin = "anonymous";

    let ok = false, lastErr = null;
    for (const url of urls) {
      try {
        el.pause(); el.src = url; el.load();
        el.volume = compat ? clamp01(volume) : 1.0;
        await el.play();
        ok = true; break;
      } catch (e) { lastErr = e; }
    }
    if (!ok) { setEtat(`échec (CORS/format)${lastErr?.name ? " : " + lastErr.name : ""}`); return; }

    // Tenter de brancher la radio dans WebAudio (pour FX/filtre)
    await attachMedia();

    setEtat(compat ? "lecture (compatibilité)" : "lecture");
    if (!compat) smooth(radioGainRef.current.gain, volume, 0.28);
    smooth(noiseGainRef.current.gain, bruit, 0.38);
  }

  function smooth(param, target, secs) {
    const ctx = ctxRef.current; const now = ctx.currentTime;
    try { param.cancelScheduledValues(now); param.setTargetAtTime(target, now, Math.max(0.01, secs)); } catch {}
  }

  /* ————— Balayage auto avec JITTER ————— */
  function startSweep() {
    stopSweep();
    const scheduleNext = () => {
      const base = msFromSpeed(vitesse);
      const jitter = alea; // 0..0.6
      const varMs = base * (Math.random() * 2 * jitter - jitter);
      const delay = Math.max(120, Math.round(base + varMs));
      sweepTimerRef.current = setTimeout(async () => {
        setStationIndex(prev => {
          const next = (prev + 1) % stations.length;
          if (marche) tuneTo(next);
          return next;
        });
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }
  function stopSweep() { if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current); sweepTimerRef.current = null; }

  /* ————— Enregistrement ————— */
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
    } else { recRef.current?.stop(); setEnr(false); }
  }

  /* ————— Réactions ————— */
  useEffect(() => { if (!ctxRef.current) return;
    // volumes
    if (radioGainRef.current) radioGainRef.current.gain.value = volume;
    if (audioElRef.current && compat) audioElRef.current.volume = clamp01(volume);
    if (noiseGainRef.current)  noiseGainRef.current.gain.value  = bruit;

    // filtre
    if (bandpassRef.current) { bandpassRef.current.Q.value = q; bandpassRef.current.frequency.value = Math.max(60, fMin); }
    rebuildChain({ compatMode: compat });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, bruit, q, fMin, filtre, compat]);

  useEffect(() => {
    if (!autoSweep) { stopSweep(); return; }
    startSweep(); return stopSweep;
  }, [autoSweep, vitesse, alea, marche, bank]); // relancer si banque change

  // FX updates
  useEffect(() => {
    if (!ctxRef.current) return;
    echoWetRef.current.gain.value = echoOn ? 0.8 : 0.0;
    echoDelayRef.current.delayTime.value = msEcho(echoTime);
    echoFbRef.current.gain.value = fbEcho(echoFb);
  }, [echoOn, echoTime, echoFb]);

  useEffect(() => {
    if (!ctxRef.current) return;
    reverbWetRef.current.gain.value = revOn ? revMix : 0.0;
    reverbConvolverRef.current.buffer = makeImpulseResponse(ctxRef.current, secRev(revSize), 2.5);
  }, [revOn, revSize, revMix]);

  /* ————— VU ————— */
  function startVuLoop() {
    const analyser = analyserRef.current; if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    function loop() {
      analyser.getByteTimeDomainData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length); const lvl = Math.min(1, rms * 1.8);
      setVuG(l => l * 0.7 + lvl * 0.3); setVuD(r => r * 0.7 + (lvl * 0.9) * 0.3);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  /* ————— UI ————— */
  const tuneValue = stations.length > 1 ? stationIndex / (stations.length - 1) : 0;

  return (
    <main style={styles.page}>
      <div style={styles.shadowWrap}>
        <div style={styles.cabinet}>
          {/* Tête */}
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

          {/* Cadran */}
          <div style={styles.glass}>
            <div style={styles.scaleWrap}>
              <div style={styles.scaleGrid} />
              {stations.map((s, i) => (
                <div key={s.name} style={{ ...styles.tick, left: `${(i/(stations.length-1))*100}%` }} />
              ))}
              <div style={{ ...styles.needle, left: `${tuneValue*100}%` }} />
            </div>
            <div style={styles.stationRow}>
              <div><strong>Banque {bank} · {stations[stationIndex].name}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && (
              <div style={styles.compatBanner}>
                Mode compatibilité CORS : FX/filtre limités à la voie BRUIT
              </div>
            )}
          </div>

          {/* Grille + VU */}
          <div style={styles.speakerSection}>
            <div style={styles.grill} />
            <div style={styles.vuWrap}>
              <Vu label="NIVEAU G" value={vuG} />
              <Vu label="NIVEAU D" value={vuD} />
            </div>
          </div>

          {/* Contrôles */}
          <div style={styles.controlsRow}>
            {/* Col. gauche */}
            <div style={styles.colLeft}>
              <Switch label="MARCHE" on={marche} onChange={async v => { setMarche(v); v ? await marcheOn() : marcheOff(); }} />
              <Switch label="FILTRE" on={filtre} onChange={setFiltre} />
              <Switch label="BALAYAGE AUTO" on={autoSweep} onChange={setAutoSweep} />
              <Knob label="VITESSE" value={vitesse} onChange={v => setVitesse(clamp01(v))} hint={`${msFromSpeed(vitesse)} ms`} />
              <Knob label="ALÉA" value={alea} onChange={v => setAlea(clamp01(v))} hint={`±${Math.round(alea*100)}%`} />
            </div>

            {/* Col. centre */}
            <div style={styles.colCenter}>
              <Knob label="VOLUME" value={volume} onChange={v => setVolume(clamp01(v))} />
              <Knob label="BRUIT"   value={bruit}  onChange={v => setBruit(clamp01(v))} />
              <Bouton label={enr ? "STOP" : "ENREGISTRER"} color={enr ? "#f0c14b" : "#d94242"} onClick={toggleEnr} />
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:8}}>
                <Switch label="ÉCHO" on={echoOn} onChange={setEchoOn} />
                <Switch label="RÉVERB" on={revOn} onChange={setRevOn} />
                <MiniDial label="Temps écho" min={0} max={1} step={0.01} value={echoTime} setValue={setEchoTime} />
                <MiniDial label="Retour écho" min={0} max={1} step={0.01} value={echoFb} setValue={setEchoFb} />
                <MiniDial label="Taille réverb" min={0} max={1} step={0.01} value={revSize} setValue={setRevSize} />
                <MiniDial label="Mix réverb" min={0} max={1} step={0.01} value={revMix} setValue={setRevMix} />
              </div>
            </div>

            {/* Col. droite */}
            <div style={styles.colRight}>
              <BigKnob
                label="RÉGLAGE"
                value={tuneValue}
                onChange={async v => {
                  const idx = Math.round(clamp01(v) * (stations.length - 1));
                  setStationIndex(idx);
                  if (marche) await tuneTo(idx);
                }}
              />
              <div style={styles.subDials}>
                <MiniDial label="Q" min={0.4} max={6} step={0.1} value={q} setValue={setQ} />
                <MiniDial label="fMin" min={60} max={2000} step={20} value={fMin} setValue={setFMin} />
                <Bouton label="SUIVANTE" onClick={async () => {
                  const next = (stationIndex + 1) % stations.length;
                  setStationIndex(next); if (marche) await tuneTo(next);
                }} />
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:6}}>
                  <Bouton label="Banque A" onClick={() => { setBank("A"); setStationIndex(0); }} />
                  <Bouton label="Banque B" onClick={() => { setBank("B"); setStationIndex(0); }} />
                </div>
              </div>
            </div>
          </div>

          <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
        </div>

        <Vis at="tl" /><Vis at="tr" /><Vis at="bl" /><Vis at="br" />
      </div>

      <p style={{ color: "rgba(255,255,255,0.7)", marginTop: 14, fontSize: 12 }}>
        Tip : active <strong>MARCHE</strong>, essaie la <strong>Banque B</strong>, teste l’<strong>ALÉA</strong> du balayage
        et joue avec <strong>ÉCHO</strong>/<strong>RÉVERB</strong>. En mode compat CORS, les FX s’appliquent surtout au <strong>BRUIT</strong>.
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
      <div style={ui.miniVal}>{(label.includes("%") ? Math.round(value*100) : Math.round(value*100)/100) || Math.round(value)}</div>
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
  scaleWrap: { position: "relative", height: 54, borderRadius: 10, border: "1px solid #252834", background: "#0d0f15", overflow: "hidden", marginBottom: 8 },
  scaleGrid: { position: "absolute", inset: 0, background: "repeating-linear-gradient(90deg, rgba(255,255,255,0.08) 0 2px, transparent 2px 12px)" },
  tick: { position: "absolute", top: 0, width: 2, height: "100%", background: "rgba(240,210,140,0.7)", transform: "translateX(-1px)" },
  needle: { position: "absolute", top: 0, width: 2, height: "100%", background: "#f05a6e", boxShadow: "0 0 10px rgba(240,90,110,0.7), 0 0 20px rgba(240,90,110,0.35)", transform: "translateX(-1px)" },
  stationRow: { display: "flex", justifyContent: "space-between", color: "#eae7f5", fontSize: 13, padding: "0 2px" },

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
  colLeft: { display: "grid", gridTemplateRows: "auto auto auto auto auto", gap: 10, alignContent: "start" },
  colCenter: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start", justifyItems: "center" },
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
