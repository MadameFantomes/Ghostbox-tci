"use client";

/**
 * Ghostbox TCI — FR (vintage + sliders + MP3 via CDN + MODE KÖNIG, skip optionnel)
 * - Enreg. MP3 (MediaRecorder si possible, sinon lamejs via CDN)
 * - Balayage corrigé (hard reset + cache-bust + wait canplay + écho muet pendant le scan)
 * - UI vintage (sliders) • RALENTI (lecture + intervalle)
 * - MODE KÖNIG : ring-mod + LPF, multi-porteuses battements (doux), skip musique optionnel et non-bloquant
 * - Charge /public/stations.json sinon fallback FR
 */

import React, { useEffect, useRef, useState } from "react";

const AUTO_FILTER = true;

// ------- Fallback (FR directs) -------
const FALLBACK_STATIONS = [
  "https://icecast.radiofrance.fr/franceinfo-midfi.mp3",
  "https://icecast.radiofrance.fr/franceinter-midfi.mp3",
  "https://icecast.radiofrance.fr/franceculture-midfi.mp3",
  "https://icecast.radiofrance.fr/francemusique-midfi.mp3",
  "https://icecast.radiofrance.fr/fip-midfi.mp3",
  "https://icecast.radiofrance.fr/fipjazz-midfi.mp3",
  "https://icecast.radiofrance.fr/fiprock-midfi.mp3",
  "https://icecast.radiofrance.fr/fipgroove-midfi.mp3",
  "https://icecast.radiofrance.fr/mouv-midfi.mp3",
  "https://stream.europe1.fr/europe1.mp3",
  "https://rmc.bfmtv.com/rmcinfo-mp3",
  "https://streaming.radio.rtl.fr/rtl-1-44-128",
  "https://streaming.radio.rtl2.fr/rtl2-1-44-128",
  "https://streaming.radio.funradio.fr/fun-1-44-128",
  "https://start-sud.ice.infomaniak.ch/start-sud-high.mp3",
  "https://radioclassique.ice.infomaniak.ch/radioclassique-high.mp3",
  "https://live02.rfi.fr/rfimonde-64.mp3",
].map((url) => ({ name: safeHost(url), url }));

function safeHost(url) {
  try { return new URL(url).host; } catch { return "station"; }
}

export default function Page() {
  const audioElRef = useRef(null);

  // Audio graph
  const ctxRef = useRef(null);
  const masterRef = useRef(null);
  const destRef = useRef(null);
  const mediaSrcRef = useRef(null);
  const radioGainRef = useRef(null);

  // BRUIT (balayage)
  const noiseNodeRef = useRef(null);
  const noiseHPRef = useRef(null);
  const noiseFilterRef = useRef(null);
  const noiseLPRef = useRef(null);
  const noiseGainRef = useRef(null);

  // Radio FX
  const radioHPRef = useRef(null);
  const radioLPRef = useRef(null);
  const radioShelfRef = useRef(null);
  const driveRef = useRef(null);

  // Mix & Écho
  const dryRef = useRef(null);
  const echoDelayRef = useRef(null);
  const echoFbRef = useRef(null);
  const echoWetRef = useRef(null);

  // “clic”
  const clickBusRef = useRef(null);

  // Somme (pour tap MP3 & traitements)
  const sumRef = useRef(null);

  // ------- MODE KÖNIG refs -------
  const kngProcRef = useRef(null);     // ScriptProcessor (ring-mod + LPF)
  const kngWetRef = useRef(null);      // Gain du signal traité
  const kngLORef = useRef({ f: 5500, p: 0 }); // LO (Hz + phase)
  const kngOscBusRef = useRef(null);   // bus multi-porteuses
  const kngOscListRef = useRef([]);    // oscillateurs + LFOs
  const kngAnalyserRef = useRef(null); // Analyser pour skip musique
  const kngEnabledRef = useRef(false);

  // Stations / index
  const [stations, setStations] = useState(FALLBACK_STATIONS);
  const stationsRef = useRef(FALLBACK_STATIONS);
  const [idx, setIdx] = useState(0);
  const idxRef = useRef(0);

  // État UI
  const [etat, setEtat] = useState("prêt");
  const [marche, setMarche] = useState(false);
  const [auto, setAuto] = useState(false);
  const [compat, setCompat] = useState(false);
  const [lent, setLent] = useState(false);
  const [kng, setKng] = useState(false);     // MODE KÖNIG (traitement)
  const [kngSkip, setKngSkip] = useState(false); // Skip musique optionnel
  const sweepTimerRef = useRef(null);
  const playingLockRef = useRef(false);

  // Contrôles
  const [vitesse, setVitesse] = useState(0.45); // 250..2500 ms
  const [volume, setVolume] = useState(0.9);
  const [echo, setEcho] = useState(0.25);
  const [debit] = useState(0.35); // burst color (fixé)

  // Enregistrement
  const [enr, setEnr] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);

  // MP3 (lamejs CDN)
  const tapProcRef = useRef(null);
  const mp3ChunksRef = useRef([]);
  const mp3EncoderRef = useRef(null);

  // LOG
  const logRef = useRef([]);
  const bcRef = useRef(null);

  // Helpers
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const msFromSpeed = (v) => Math.round(250 + v * (2500 - 250));
  const BASE_NOISE = 0.006; // bruit très bas
  const burstMs = () => Math.round(120 + debit * 520);
  const burstGain = () => Math.min(0.4, 0.08 + debit * 0.32);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sweepDelayMs = () => Math.round(msFromSpeed(vitesse) * (lent ? 2.5 : 1));

  // --- anti-boucle / anti-cache ---
  const cacheBust = (u) => {
    try {
      const url = new URL(u);
      url.searchParams.set("gbx", Date.now().toString(36));
      return url.toString();
    } catch {
      return u + (u.includes("?") ? "&" : "?") + "gbx=" + Date.now().toString(36);
    }
  };
  async function hardStop(el) {
    if (!el) return;
    try { el.pause(); } catch {}
    try { el.removeAttribute("src"); } catch {}
    try { el.src = ""; } catch {}
    try { el.load(); } catch {}
    await sleep(40);
  }
  function waitFor(el, events = ["playing", "canplay"], timeout = 2500) {
    return new Promise((resolve, reject) => {
      let done = false;
      const on = () => { if (done) return; done = true; cleanup(); resolve(); };
      const cleanup = () => events.forEach((ev) => el.removeEventListener(ev, on));
      events.forEach((ev) => el.addEventListener(ev, on, { once: true }));
      setTimeout(() => { if (done) return; done = true; cleanup(); reject(new Error("timeout")); }, timeout);
    });
  }

  // ------- LOG -------
  useEffect(() => {
    try { bcRef.current = new BroadcastChannel("labo-ghostbox"); } catch {}
    return () => { try { bcRef.current?.close(); } catch {} };
  }, []);
  function addLog(event, extra = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      event, vitesse, lent, kng, kngSkip, volume, echo,
      station: stationsRef.current[idxRef.current]?.name || null,
      ...extra,
    };
    logRef.current.push(entry);
    try {
      const key = "ghostbox.logs";
      const prev = JSON.parse(localStorage.getItem(key) || "[]");
      prev.push(entry);
      localStorage.setItem(key, JSON.stringify(prev));
    } catch {}
    try { bcRef.current?.postMessage(entry); } catch {}
  }
  function exportLog() {
    try {
      const blob = new Blob([JSON.stringify(logRef.current, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `ghostbox-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch {}
  }

  // ------- Charger /stations.json -------
  useEffect(() => { (async () => {
    try {
      const r = await fetch("/stations.json", { cache: "no-store" });
      if (!r.ok) throw new Error();
      const flat = normalizeStationsJson(await r.json());
      if (flat.length) { setStations(flat); stationsRef.current = flat; idxRef.current = 0; setIdx(0); }
    } catch { stationsRef.current = FALLBACK_STATIONS; }
  })(); }, []);
  function normalizeStationsJson(json) {
    let list = [];
    const push = (name, url, suffix = "") => {
      if (!url || typeof url !== "string") return;
      if (!/^https:/i.test(url)) return;
      try {
        url = url.trim();
        list.push({ name: (name && name.trim()) || safeHost(url) + suffix, url });
      } catch {}
    };
    if (Array.isArray(json)) {
      json.forEach((s) => {
        if (!s) return;
        if (s.url) push(s.name, s.url);
        if (Array.isArray(s.urls)) s.urls.forEach((u, k) => push(s.name, u, ` #${k + 1}`));
      });
    } else if (json && typeof json === "object") {
      Object.entries(json).forEach(([group, arr]) => Array.isArray(arr) && arr.forEach((s) => {
        if (!s) return;
        if (s.url) push(s.name || group, s.url);
        if (Array.isArray(s.urls)) s.urls.forEach((u, k) => push(s.name || group, u, ` #${k + 1}`));
      }));
    }
    const seen = new Set();
    list = list.filter((s) => (seen.has(s.url) ? false : seen.add(s.url)));
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  }

  // ------- Init WebAudio -------
  async function initAudio() {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)(); ctxRef.current = ctx;

    // Master
    const master = ctx.createGain(); master.gain.value = clamp01(volume); master.connect(ctx.destination); masterRef.current = master;

    // Enregistrement (MediaRecorder natif)
    const dest = ctx.createMediaStreamDestination(); master.connect(dest); destRef.current = dest;

    // Radio
    const gRadio = ctx.createGain(); gRadio.gain.value = 1; radioGainRef.current = gRadio;

    // Bruit
    const noise = createNoiseNode(ctx); noiseNodeRef.current = noise;
    const hpN = ctx.createBiquadFilter(); hpN.type = "highpass"; hpN.frequency.value = 160; hpN.Q.value = 0.7;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.55; bp.frequency.value = 1800;
    const lpN = ctx.createBiquadFilter(); lpN.type = "lowpass"; lpN.frequency.value = 5200; lpN.Q.value = 0.3;
    noiseHPRef.current = hpN; noiseFilterRef.current = bp; noiseLPRef.current = lpN;
    const gNoise = ctx.createGain(); gNoise.gain.value = 0; noiseGainRef.current = gNoise;

    // Radio auto-filtre
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 320; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3400; lp.Q.value = 0.7;
    const shelf = ctx.createBiquadFilter(); shelf.type = "highshelf"; shelf.frequency.value = 2500; shelf.gain.value = -4;
    const drive = createDriveNode(ctx, 0.22);
    radioHPRef.current = hp; radioLPRef.current = lp; radioShelfRef.current = shelf; driveRef.current = drive;

    // Dry & ÉCHO
    const dry = ctx.createGain(); dry.gain.value = 1; dryRef.current = dry;
    const dly = ctx.createDelay(1.2); dly.delayTime.value = 0.34;
    const fb = ctx.createGain(); fb.gain.value = 0.22; dly.connect(fb); fb.connect(dly);
    const wet = ctx.createGain(); wet.gain.value = 0; echoDelayRef.current = dly; echoFbRef.current = fb; echoWetRef.current = wet;

    // “clic”
    const clickBus = ctx.createGain(); clickBus.gain.value = 0; clickBus.connect(master); clickBusRef.current = clickBus;

    // Somme → master (réf pour traitements)
    const sum = ctx.createGain(); sum.gain.value = 1; sumRef.current = sum;

    // bruit : noise → HP → BP → LP → gNoise → sum
    noise.connect(hpN); hpN.connect(bp); bp.connect(lpN); lpN.connect(gNoise); gNoise.connect(sum);
    // radio : branchée après attachMedia → gRadio → sum
    gRadio.connect(sum);

    // sum → dry/master + echo
    sum.connect(dry); dry.connect(master);
    sum.connect(dly); dly.connect(wet); wet.connect(master);

    try { noise.start(0); } catch {}
  }

  function createNoiseNode(ctx) {
    const size = 2 * ctx.sampleRate;
    const buf = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * 0.9;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; return src;
  }
  function createDriveNode(ctx, amount = 0.25) {
    const ws = ctx.createWaveShaper(); ws.curve = makeDistortionCurve(amount); ws.oversample = "4x"; return ws;
  }
  function makeDistortionCurve(amount = 0.25) {
    const k = amount * 100, n = 44100, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    return curve;
  }
  function applyAutoFilterProfile() {
    const ctx = ctxRef.current; if (!AUTO_FILTER || !ctx || !radioHPRef.current) return;
    const now = ctx.currentTime;
    const hpF = 260 + Math.random() * 160;
    const lpF = 2800 + Math.random() * 1400;
    const shelfGain = -(2 + Math.random() * 5);
    const driveAmt = 0.16 + Math.random() * 0.12;
    try {
      radioHPRef.current.frequency.setTargetAtTime(hpF, now, 0.08);
      radioLPRef.current.frequency.setTargetAtTime(lpF, now, 0.08);
      radioShelfRef.current.gain.setTargetAtTime(shelfGain, now, 0.1);
      driveRef.current.curve = makeDistortionCurve(driveAmt);
    } catch {}
  }

  async function attachMedia() {
    if (!ctxRef.current || !audioElRef.current) return;
    if (mediaSrcRef.current) return;
    try {
      const src = ctxRef.current.createMediaElementSource(audioElRef.current);
      mediaSrcRef.current = src;

      if (AUTO_FILTER && radioHPRef.current) {
        src.connect(radioHPRef.current); radioHPRef.current.connect(radioLPRef.current);
        radioLPRef.current.connect(radioShelfRef.current); radioShelfRef.current.connect(driveRef.current);
        driveRef.current.connect(radioGainRef.current);
      } else {
        src.connect(radioGainRef.current);
      }

      // ducking du bruit
      const el = audioElRef.current;
      const duckToFloor = () => {
        const now = ctxRef.current.currentTime;
        try {
          noiseGainRef.current.gain.cancelScheduledValues(now);
          noiseGainRef.current.gain.setTargetAtTime(BASE_NOISE, now, 0.12);
        } catch {}
      };
      el.addEventListener("playing", duckToFloor);
      el.addEventListener("timeupdate", duckToFloor);
      attachMedia._cleanup = () => {
        el.removeEventListener("playing", duckToFloor);
        el.removeEventListener("timeupdate", duckToFloor);
      };

      setCompat(false);
    } catch {
      // Fallback: tentative captureStream si CORS
      try {
        const el = audioElRef.current; const ms = el.captureStream?.();
        if (ms && ms.getAudioTracks().length) {
          const src2 = ctxRef.current.createMediaStreamSource(ms);
          mediaSrcRef.current = src2; src2.connect(radioGainRef.current); setCompat(false);
        } else { setCompat(true); }
      } catch { setCompat(true); }
    }
  }

  // ------- MODE KÖNIG impl -------
  function kngEnable() {
    if (kngEnabledRef.current) return;
    const ctx = ctxRef.current; if (!ctx || !sumRef.current || !masterRef.current) return;

    // 1) Ring-mod + LPF (ScriptProcessor)
    const proc = ctx.createScriptProcessor(1024, 2, 2);
    const wet = ctx.createGain(); wet.gain.value = 0; // mix traité
    const lo = kngLORef.current; lo.f = 5500; lo.p = 0;

    const fc = 2200; // LPF un peu plus haut (consonnes)
    const alpha = 1 - Math.exp(-2 * Math.PI * fc / ctx.sampleRate);
    let yL = 0, yR = 0;

    proc.onaudioprocess = (ev) => {
      const iL = ev.inputBuffer.getChannelData(0);
      const iR = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : iL;
      const oL = ev.outputBuffer.getChannelData(0);
      const oR = ev.outputBuffer.numberOfChannels > 1 ? ev.outputBuffer.getChannelData(1) : oL;
      const inc = 2 * Math.PI * lo.f / ctx.sampleRate;
      let phase = lo.p;

      for (let n = 0; n < iL.length; n++) {
        const s = Math.sin(phase);
        phase += inc; if (phase > 1e9) phase = phase % (2 * Math.PI);
        const mL = iL[n] * s;
        const mR = iR[n] * s;
        yL = yL + alpha * (mL - yL); // 1-pole LPF
        yR = yR + alpha * (mR - yR);
        oL[n] = yL; oR[n] = yR;
      }
      lo.p = phase;
    };

    sumRef.current.connect(proc); proc.connect(wet); wet.connect(masterRef.current);
    kngProcRef.current = proc; kngWetRef.current = wet;

    // 2) Multi-porteuses + battements (beaucoup plus doux)
    const bus = ctx.createGain(); bus.gain.value = 0.08; // global carriers
    bus.connect(sumRef.current); kngOscBusRef.current = bus;

    const freqs = [1700, 2300, 3100, 5000, 8500];
    const oscList = [];
    freqs.forEach((f) => {
      const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.003; // base très faible
      osc.connect(g); g.connect(bus);

      // LFO lent 0.2..1.8 Hz — modulation d'amplitude
      const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 0.2 + Math.random() * 1.6;
      const lfoAmp = ctx.createGain(); lfoAmp.gain.value = 0.002; // profondeur
      lfo.connect(lfoAmp); lfoAmp.connect(g.gain);

      // Offset DC pour part constante
      const base = ctx.createConstantSource(); base.offset.value = 0.002; base.connect(g.gain); base.start();

      try { osc.start(); lfo.start(); } catch {}
      oscList.push({ osc, g, lfo, lfoAmp, base });
    });
    kngOscListRef.current = oscList;

    // 3) Analyser (pour skip musique si activé)
    const an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0;
    kngAnalyserRef.current = an; try { radioGainRef.current.connect(an); } catch {}

    // montée douce du mix traité (plus faible)
    try { wet.gain.setTargetAtTime(0.22, ctx.currentTime, 0.15); } catch {}
    kngEnabledRef.current = true; addLog("koenig_on");
  }
  function kngDisable() {
    if (!kngEnabledRef.current) return;
    const ctx = ctxRef.current;

    // ring-mod
    try {
      kngWetRef.current?.gain?.setTargetAtTime(0, ctx.currentTime, 0.1);
      setTimeout(() => {
        try { sumRef.current?.disconnect(kngProcRef.current); } catch {}
        try { kngProcRef.current?.disconnect(); } catch {}
        kngProcRef.current = null; kngWetRef.current = null;
      }, 150);
    } catch {}

    // porteuses
    try {
      kngOscListRef.current.forEach(({ osc, g, lfo, lfoAmp, base }) => {
        try { osc.stop(); lfo.stop(); } catch {}
        try { base.disconnect(); } catch {}
        try { lfoAmp.disconnect(); } catch {}
        try { g.disconnect(); } catch {}
      });
      kngOscListRef.current = [];
      kngOscBusRef.current?.disconnect();
      kngOscBusRef.current = null;
    } catch {}

    // analyser
    try { radioGainRef.current?.disconnect(kngAnalyserRef.current); } catch {}
    kngAnalyserRef.current = null;

    kngEnabledRef.current = false; addLog("koenig_off");
  }
  useEffect(() => { if (!ctxRef.current) return; if (kng) kngEnable(); else kngDisable(); /* eslint-disable-next-line */ }, [kng]);

  // ------- Power -------
  async function powerOn() {
    await initAudio();
    const ctx = ctxRef.current; if (ctx.state === "suspended") await ctx.resume();
    try { noiseGainRef.current.gain.value = BASE_NOISE; } catch {}
    addLog("power_on"); await playIndex(idxRef.current); setMarche(true);
  }
  async function powerOff() {
    stopSweep();
    const el = audioElRef.current;
    try { noiseGainRef.current.gain.value = 0; } catch {}
    if (el) { await hardStop(el); }
    if (attachMedia._cleanup) attachMedia._cleanup();
    if (enr) { try { recRef.current?.stop(); } catch {} setEnr(false); }
    try { await ctxRef.current?.suspend(); } catch {}
    setMarche(false); setAuto(false); setEtat("arrêté"); playingLockRef.current = false; addLog("power_off");
  }

  function triggerClick(level = 0.28) {
    const ctx = ctxRef.current; if (!ctx || !clickBusRef.current) return;
    const dur = 0.012;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(dur * ctx.sampleRate)), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/d.length, 12);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = clickBusRef.current; const now = ctx.currentTime;
    try { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(level, now); g.gain.exponentialRampToValueAtTime(0.0001, now + dur); } catch {}
    src.connect(g); src.start();
  }

  function playScanBurst(targetGain, durSec) {
    const ctx = ctxRef.current; if (!ctx) return; const now = ctx.currentTime;
    const bp = noiseFilterRef.current, hp = noiseHPRef.current, lp = noiseLPRef.current; const g = noiseGainRef.current?.gain;
    const q = 0.35 + debit * 0.45, lpF = 4200 + debit * 1600, hpF = 160 + debit * 180;
    try { bp.Q.setTargetAtTime(q, now, 0.05); lp.frequency.setTargetAtTime(lpF, now, 0.08); hp.frequency.setTargetAtTime(hpF, now, 0.08); } catch {}
    const fStart = 800 + Math.random()*800, fMid = 1300 + Math.random()*1500, fEnd = 1800 + Math.random()*1800;
    const steps = Math.max(4, Math.floor(durSec * 10));
    for (let i = 0; i <= steps; i++) {
      const t = now + (durSec * i) / steps, x = i / steps;
      const f = x < 0.6 ? fStart + ((fMid - fStart) * x) / 0.6 : fMid + ((fEnd - fMid) * (x - 0.6)) / 0.4;
      const jitter = (Math.random()*2 - 1) * (80 + 380*(1 - debit));
      try { bp.frequency.linearRampToValueAtTime(Math.max(300, f + jitter), t); } catch {}
    }
    try {
      g.cancelScheduledValues(now);
      const attack = Math.min(0.05, durSec * 0.22);
      g.setValueAtTime(BASE_NOISE, now);
      g.linearRampToValueAtTime(targetGain * (0.42 + 0.12*Math.random()), now + attack);
      const wobbleN = Math.max(2, Math.floor(durSec / 0.1));
      for (let i=1;i<=wobbleN;i++){
        const t = now + attack + ((durSec - attack) * i) / wobbleN;
        const lvl = targetGain * (0.38 + 0.22*Math.random());
        g.linearRampToValueAtTime(lvl, t);
      }
    } catch {}
  }

  // ------- Évaluation station (skip musique pour MODE KÖNIG) -------
  async function kngEvaluateStation(msWindow = 700, frames = 10) {
    const an = kngAnalyserRef.current; if (!kng || !kngSkip || !an) return { keep: true, score: 0 };
    const arr = new Float32Array(an.frequencyBinCount);
    let sumFlat = 0;
    for (let i = 0; i < frames; i++) {
      an.getFloatFrequencyData(arr);
      // convert dB -> amplitude linéaire
      let gm = 0, am = 0, count = 0;
      for (let k = 4; k < arr.length; k++) {
        const m = Math.max(1e-8, Math.pow(10, arr[k] / 20));
        am += m; gm += Math.log(m); count++;
      }
      gm = Math.exp(gm / count); am = am / count;
      const flat = gm / am; // 0..1 (tonal -> bas, bruité -> haut)
      sumFlat += flat;
      await sleep(msWindow / frames);
    }
    const meanFlat = sumFlat / frames;
    return { keep: meanFlat >= 0.32, score: meanFlat };
  }

  // ------- Lecture robuste -------
  async function playIndex(startIndex, tries = 0) {
    const list = stationsRef.current; if (!list.length) return;
    if (tries >= list.length) { setEtat("aucun flux lisible"); return; }
    if (playingLockRef.current) return; playingLockRef.current = true;

    const el = audioElRef.current;
    const entry = list[startIndex]; const url = typeof entry === "string" ? entry : entry.url;
    const ctx = ctxRef.current; const now = ctx.currentTime;
    const dur = burstMs() / 1000; const targetNoise = burstGain();

    // 1) clic + montée du bruit + baisse radio + MUTE ECHO
    triggerClick();
    try {
      echoWetRef.current.gain.cancelScheduledValues(now);
      echoWetRef.current.gain.setValueAtTime(0, now);
    } catch {}
    try {
      if (!compat) {
        radioGainRef.current.gain.cancelScheduledValues(now);
        radioGainRef.current.gain.linearRampToValueAtTime(0.0001, now + 0.05);
      } else { el.volume = 0; }
    } catch {}

    playScanBurst(targetNoise, dur);
    setEtat("balayage…");
    addLog("scan_burst", { targetNoise, dur });
    await sleep(Math.max(80, dur * 500));

    // 2) HARD STOP + cache-busting + lecture
    try {
      await hardStop(el);
      el.crossOrigin = "anonymous";
      el.preload = "none";
      el.src = cacheBust(url);
      try {
        el.playbackRate = lent ? 0.88 : 1;
        if ("preservesPitch" in el) el.preservesPitch = false;
        if ("mozPreservesPitch" in el) el.mozPreservesPitch = false;
        if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = false;
      } catch {}
      const playP = el.play().catch(() => {});
      await Promise.race([waitFor(el, ["playing","canplay"], 2200), playP]);

      await attachMedia();
      applyAutoFilterProfile();

      // 2b) MODE KÖNIG : évaluation asynchrone optionnelle (ne bloque pas la montée)
      if (kng && kngSkip && auto) {
        const myIndex = startIndex;
        setTimeout(async () => {
          const ev = await kngEvaluateStation(650, 8);
          addLog("kng_eval", { flatness: Number((ev?.score ?? 0).toFixed(3)), keep: !!ev?.keep });
          if (!ev?.keep && marche && auto && idxRef.current === myIndex) {
            const next = (myIndex + 1) % stationsRef.current.length;
            await playIndex(next);
          }
        }, 800);
      }

      // 3) retour
      const after = ctx.currentTime + Math.max(0.06, dur * 0.45);
      try {
        noiseGainRef.current.gain.setTargetAtTime(BASE_NOISE, after, 0.1);
        if (!compat) radioGainRef.current.gain.setTargetAtTime(1, after, 0.07);
        else el.volume = clamp01(volume);
        // rétablir l'écho selon le slider (pas le précédent wet)
        echoWetRef.current.gain.setTargetAtTime(echo * 0.9, after + 0.05, 0.12);
      } catch {}

      idxRef.current = startIndex; setIdx(startIndex);
      setEtat(compat ? "lecture (compatibilité)" : "lecture");
      addLog("play_station", { url, compat });
    } catch {
      try {
        noiseGainRef.current.gain.setTargetAtTime(BASE_NOISE, ctx.currentTime + 0.05, 0.12);
        echoWetRef.current.gain.setTargetAtTime(echo * 0.9, ctx.currentTime + 0.05, 0.1);
      } catch {}
      const next = (startIndex + 1) % list.length;
      playingLockRef.current = false; await playIndex(next, tries + 1); return;
    }
    playingLockRef.current = false;
  }

  // ------- Balayage auto -------
  function startSweep() {
    stopSweep();
    const tick = async () => {
      if (!marche) return;
      const list = stationsRef.current; if (!list.length) return;
      const next = (idxRef.current + 1) % list.length;
      await playIndex(next);
      sweepTimerRef.current = setTimeout(tick, sweepDelayMs());
    };
    sweepTimerRef.current = setTimeout(tick, sweepDelayMs());
  }
  function stopSweep() { if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current); sweepTimerRef.current = null; }

  // ------- Chargeur lamejs (CDN) -------
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  async function loadLame() {
    if (typeof window !== "undefined" && (window.lamejs || window.Lame || window.lame)) {
      return window.lamejs || window.Lame || window.lame;
    }
    const cdns = [
      "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js",
      "https://unpkg.com/lamejs@1.2.1/lame.min.js",
    ];
    for (const url of cdns) { try { await loadScript(url); break; } catch {} }
    const lib = window.lamejs || window.Lame || window.lame;
    if (!lib) throw new Error("lamejs introuvable");
    return lib;
  }

  // ------- Enregistrement (MP3 prioritaire) -------
  async function toggleEnr() {
    if (!ctxRef.current) await initAudio();
    if (!destRef.current) return;

    if (!enr) {
      let useNative = "MediaRecorder" in window && MediaRecorder.isTypeSupported?.("audio/mpeg");
      if (useNative) {
        let rec; try { rec = new MediaRecorder(destRef.current.stream, { mimeType: "audio/mpeg" }); }
        catch { rec = new MediaRecorder(destRef.current.stream); }
        chunksRef.current = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
        rec.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = `ghostbox-${ts()}.mp3`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        };
        rec.start(); recRef.current = rec; setEnr(true); addLog("rec_start_native");
      } else {
        // lamejs via CDN
        try {
          const lame = await loadLame();
          const Mp3Encoder = lame.Mp3Encoder || lame.default?.Mp3Encoder || lame["lamejs"]?.Mp3Encoder;
          if (!Mp3Encoder) throw new Error("Mp3Encoder absent");
          const ctx = ctxRef.current; const channels = 2; const kbps = 128;
          mp3EncoderRef.current = new Mp3Encoder(channels, ctx.sampleRate, kbps);
          mp3ChunksRef.current = [];
          const proc = ctx.createScriptProcessor(4096, channels, channels); tapProcRef.current = proc;
          sumRef.current.connect(proc);
          const zero = ctx.createGain(); zero.gain.value = 0; proc.connect(zero); zero.connect(ctx.destination);
          proc.onaudioprocess = (ev) => {
            const inL = ev.inputBuffer.getChannelData(0);
            const inR = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : inL;
            const l16 = f32ToI16(inL), r16 = f32ToI16(inR);
            const data = mp3EncoderRef.current.encodeBuffer(l16, r16);
            if (data && data.length) mp3ChunksRef.current.push(new Int8Array(data));
          };
          setEnr(true); addLog("rec_start_lamejs_cdn");
        } catch {
          // dernier recours : webm
          let rec; try { rec = new MediaRecorder(destRef.current.stream, { mimeType: "audio/webm;codecs=opus" }); }
          catch { rec = new MediaRecorder(destRef.current.stream); }
          chunksRef.current = [];
          rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunksRef.current.push(ev.data); };
          rec.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: "audio/webm" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `ghostbox-${ts()}.webm`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
          };
          rec.start(); recRef.current = rec; setEnr(true); addLog("rec_start_webm_fallback");
        }
      }
    } else {
      if (tapProcRef.current && mp3EncoderRef.current) {
        try {
          tapProcRef.current.disconnect(); tapProcRef.current.onaudioprocess = null; tapProcRef.current = null;
          const rest = mp3EncoderRef.current.flush(); if (rest && rest.length) mp3ChunksRef.current.push(new Int8Array(rest));
          const blob = new Blob(mp3ChunksRef.current, { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = `ghostbox-${ts()}.mp3`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        } catch {}
        mp3EncoderRef.current = null; mp3ChunksRef.current = [];
      } else {
        try { recRef.current?.stop(); } catch {}
      }
      setEnr(false); addLog("rec_stop");
    }
  }

  function f32ToI16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  function ts() { return new Date().toISOString().replace(/[:.]/g, "-"); }

  /* ------- Réactions contrôles ------- */
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
  }, [auto, vitesse, marche, lent]);
  useEffect(() => {
    const el = audioElRef.current; if (!el) return;
    try {
      el.playbackRate = lent ? 0.88 : 1;
      if ("preservesPitch" in el) el.preservesPitch = false;
      if ("mozPreservesPitch" in el) el.mozPreservesPitch = false;
      if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = false;
    } catch {}
  }, [lent]);

  /* ------- UI ------- */
  const list = stationsRef.current; const current = list[idxRef.current];
  const currentName = current?.name || (current?.url ? safeHost(current.url) : "");

  return (
    <main style={styles.page}>
      <div style={styles.shadowWrap}>
        <div style={styles.cabinet}>
          <div style={styles.textureOverlay} />

          {/* Bandeau titre */}
          <div style={styles.headerBar}>
            <div style={styles.brandPlate}>
              <div style={styles.brandText}>MADAME FANTÔMES</div>
              <div style={styles.brandSub}>Ghostbox • TCI</div>
            </div>
            <div style={styles.rightHeader}>
              <div style={styles.lampsRow}>
                <Lamp label="MARCHE" on={marche} />
                <Lamp label="AUTO" on={auto} colorOn="#86fb6a" />
                <Lamp label="ENR" on={enr} colorOn="#ff6a6a" />
                <Lamp label="KÖNIG" on={kng} colorOn="#7cc7ff" />
              </div>
            </div>
          </div>

          {/* Cadran rétro */}
          <div style={styles.dialWrap}>
            <div style={styles.dialGlass}>
              <div style={styles.scale}>{Array.from({ length: 11 }).map((_, i) => (<div key={i} style={styles.tick} />))}</div>
              <div style={styles.needle} />
            </div>
          </div>

          {/* Fenêtre état */}
          <div style={styles.glass}>
            <div style={styles.stationRow}>
              <div><strong>{currentName || "—"}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && (<div style={styles.compatBanner}>Compat CORS : traitement radio limité</div>)}
          </div>

          {/* Panneau commandes */}
          <div style={styles.controlsRow}>
            <div style={styles.switches}>
              <Switch label="MARCHE" on={marche} onChange={async (v) => { setMarche(v); if (v) await powerOn(); else await powerOff(); }} />
              <Switch label="BALAYAGE AUTO" on={auto} onChange={(v) => { setAuto(v); addLog(v ? "auto_on" : "auto_off"); }} />
              <Switch label="RALENTI" on={lent} onChange={(v) => { setLent(v); addLog(v ? "slow_on" : "slow_off"); }} />
              <Switch label="MODE KÖNIG" on={kng} onChange={(v) => setKng(v)} />
              <Switch label="SKIP MUSIQUE (KÖNIG)" on={kngSkip} onChange={(v) => setKngSkip(v)} />

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Bouton label={enr ? "STOP ENREG." : "ENREGISTRER"} onClick={toggleEnr} color={enr ? "#f0c14b" : "#c76d4b"} />
                <Bouton label="Exporter log" onClick={exportLog} color="#e7dcc6" />
              </div>
            </div>

            <div style={styles.sliders}>
              <Slider label="VITESSE" value={vitesse} onChange={(v) => setVitesse(clamp01(v))} hint={`${sweepDelayMs()} ms`} />
              <Slider label="VOLUME" value={volume} onChange={(v) => setVolume(clamp01(v))} />
              <Slider label="ÉCHO" value={echo} onChange={(v) => setEcho(clamp01(v))} />
            </div>
          </div>

          {/* Grille HP rétro */}
          <div style={styles.speakerGrille} />

          <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
        </div>

        <Vis at="tl" /><Vis at="tr" /><Vis at="bl" /><Vis at="br" />
      </div>

      <p style={{ color: "rgba(60,40,20,0.85)", marginTop: 10, fontSize: 12 }}>
        Mode KÖNIG traité en douceur; “Skip musique” est séparé (optionnel). MP3 via CDN ok.
      </p>
    </main>
  );
}

/* ------- Slider custom (ultra fluide) ------- */
function Slider({ label, value, onChange, hint }) {
  const barRef = useRef(null); const [drag, setDrag] = useState(false);
  const setFromClientX = (clientX) => {
    const rect = barRef.current.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    onChange(Math.max(0, Math.min(1, x)));
  };
  return (
    <div style={ui.sliderBlock}>
      <div style={ui.sliderLabel}>{label}</div>
      <div
        ref={barRef}
        style={ui.sliderRail}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(true); setFromClientX(e.clientX); }}
        onPointerMove={(e) => { if (drag) setFromClientX(e.clientX); }}
        onPointerUp={() => setDrag(false)}
        onPointerCancel={() => setDrag(false)}
      >
        <div style={{ ...ui.sliderFill, width: `${value * 100}%` }} />
        <div style={{ ...ui.sliderThumb, left: `${value * 100}%` }} />
      </div>
      {hint && <div style={ui.hint}>{hint}</div>}
    </div>
  );
}

/* ------- UI ------- */
function Switch({ label, on, onChange }) {
  return (
    <div style={ui.switchBlock} onClick={() => onChange(!on)}>
      <div style={ui.switchLabel}>{label}</div>
      <div style={{ ...ui.switch, background: on ? "#7BC67B" : "#b9a48f" }}>
        <div style={{ ...ui.switchDot, transform: `translateX(${on ? 30 : 0}px)` }} />
      </div>
    </div>
  );
}
function Bouton({ label, onClick, color = "#b77d56" }) {
  return <button onClick={onClick} style={{ ...ui.button, background: color }}>{label}</button>;
}
function Lamp({ label, on, colorOn = "#86fb6a" }) {
  return (
    <div style={ui.lamp}>
      <div style={{
        ...ui.lampDot,
        background: on ? colorOn : "#5a4a3f",
        boxShadow: on ? "0 0 14px rgba(134,251,106,0.55)" : "inset 0 0 4px rgba(0,0,0,0.5)"
      }} />
      <div style={ui.lampLabel}>{label}</div>
    </div>
  );
}
function Vis({ at }) {
  const pos = { tl: { top: -8, left: -8 }, tr: { top: -8, right: -8 }, bl: { bottom: -8, left: -8 }, br: { bottom: -8, right: -8 } }[at] || {};
  return <div style={{ ...decor.screw, ...pos }} />;
}

/* ------- Styles vintage ------- */
const styles = {
  page: { minHeight: "100vh", background: "linear-gradient(180deg,#f1d6ad 0%,#e6c79c 55%,#dfbd90 100%)", display: "grid", placeItems: "center", padding: 24 },
  shadowWrap: { position: "relative" },
  cabinet: {
    width: "min(980px, 94vw)", borderRadius: 28, padding: 18, border: "1px solid rgba(90,60,30,0.5)",
    background: "linear-gradient(180deg,#d1a46d,#b58854 80%,#9f7747), url('/skin-watercolor.svg')",
    backgroundBlendMode: "multiply", backgroundSize: "cover",
    boxShadow: "0 40px 90px rgba(70,45,20,0.45), inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -3px 0 rgba(0,0,0,0.25)",
    position: "relative", overflow: "hidden",
  },
  textureOverlay: { position: "absolute", inset: 0, pointerEvents: "none", background: "radial-gradient(1200px 600px at 20% 10%, rgba(255,255,255,0.18), transparent 60%),radial-gradient(900px 500px at 80% 80%, rgba(0,0,0,0.18), transparent 55%)", mixBlendMode: "overlay" },
  headerBar: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  brandPlate: { background: "linear-gradient(180deg,#6a4a2e,#4f3520)", color: "#fbedd7", borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)", padding: "10px 14px", letterSpacing: 1.2, boxShadow: "inset 0 0 18px rgba(0,0,0,0.5), 0 4px 12px rgba(0,0,0,0.25)" },
  brandText: { fontFamily: "Georgia,serif", fontWeight: 800, fontSize: 15 },
  brandSub: { fontFamily: "Georgia,serif", fontSize: 12, opacity: 0.85 },
  rightHeader: { display: "flex", alignItems: "center", gap: 12 },
  lampsRow: { display: "flex", gap: 14, alignItems: "center" },

  dialWrap: { borderRadius: 16, border: "1px solid rgba(60,40,20,0.5)", background: "linear-gradient(180deg,#f8e8c6,#e8d1a8)", padding: 10, marginBottom: 10, boxShadow: "inset 0 0 28px rgba(0,0,0,0.28)" },
  dialGlass: { position: "relative", height: 64, borderRadius: 12, background: "linear-gradient(180deg,#fff9ea,#f6e1b9)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), inset 0 -2px 10px rgba(0,0,0,0.15)", overflow: "hidden" },
  scale: { position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "repeat(11,1fr)", alignItems: "center", padding: "0 16px" },
  tick: { width: 2, height: 16, background: "#6c543d", justifySelf: "center" },
  needle: { position: "absolute", left: "50%", top: 6, width: 2, height: "calc(100% - 12px)", background: "#2e2015", boxShadow: "0 0 0 1px rgba(255,255,255,0.2)", transform: "translateX(-50%)", borderRadius: 2 },

  glass: { borderRadius: 14, border: "1px solid rgba(76,56,36,0.6)", background: "linear-gradient(180deg, rgba(255,236,200,0.7), rgba(230,200,160,0.8))", padding: 10, position: "relative", overflow: "hidden", boxShadow: "inset 0 0 26px rgba(0,0,0,0.35)" },
  stationRow: { display: "flex", justifyContent: "space-between", color: "#3a2a1a", fontSize: 13, padding: "2px 2px" },
  compatBanner: { position: "absolute", right: 10, bottom: 10, background: "rgba(240,180,60,0.18)", border: "1px solid rgba(240,180,60,0.35)", color: "#7a5418", padding: "6px 10px", borderRadius: 8, fontSize: 12 },

  controlsRow: { marginTop: 14, display: "grid", gridTemplateColumns: "1fr 2fr", gap: 14, alignItems: "center" },
  switches: { display: "grid", gap: 10, alignContent: "start" },

  sliders: { display: "grid", gridTemplateColumns: "repeat(3, minmax(220px, 1fr))", gap: 16, alignItems: "center", justifyItems: "center" },

  speakerGrille: { marginTop: 14, height: 140, borderRadius: 18, border: "1px solid rgba(60,40,20,0.5)", background: "radial-gradient(circle at 8px 8px, rgba(40,22,12,0.9) 1.5px, transparent 2px) 0 0 / 16px 16px,linear-gradient(180deg,#a87a48,#8f6437)", boxShadow: "inset 0 12px 28px rgba(0,0,0,0.45), inset 0 -6px 18px rgba(0,0,0,0.35)" },
};

const ui = {
  hint: { color: "rgba(60,40,20,0.7)", fontSize: 11, marginTop: 2 },
  sliderBlock: { display: "grid", gap: 6, justifyItems: "stretch" },
  sliderLabel: { color: "#3a2a1a", fontSize: 12, letterSpacing: 1.2, fontFamily: "Georgia,serif", textAlign: "center" },
  sliderRail: {
    position: "relative", width: "100%", height: 30, borderRadius: 16,
    border: "1px solid rgba(70,50,30,0.6)",
    background: "linear-gradient(180deg,#d7c2a4,#b79a77)",
    boxShadow: "inset 0 2px 0 rgba(255,255,255,0.6), inset 0 -3px 0 rgba(0,0,0,0.15)",
    touchAction: "none", userSelect: "none", cursor: "pointer"
  },
  sliderFill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 16, background: "linear-gradient(180deg,#b98556,#9a6b42)" },
  sliderThumb: {
    position: "absolute", top: "50%", transform: "translate(-50%,-50%)",
    width: 22, height: 22, borderRadius: "50%", background: "#6e553d",
    border: "1px solid rgba(40,25,10,0.5)",
    boxShadow: "0 3px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.4)"
  },

  switchBlock: { display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 10, cursor: "pointer" },
  switchLabel: { color: "#3a2a1a", fontSize: 12, letterSpacing: 1.2, fontFamily: "Georgia,serif" },
  switch: {
    width: 58, height: 26, borderRadius: 16, position: "relative",
    border: "1px solid rgba(70,50,30,0.6)",
    background: "linear-gradient(180deg,#d7c2a4,#b79a77)",
    boxShadow: "inset 0 2px 0 rgba(255,255,255,0.6), inset 0 -3px 0 rgba(0,0,0,0.15)"
  },
  switchDot: {
    width: 24, height: 24, borderRadius: "50%", background: "#6e553d",
    border: "1px solid rgba(40,25,10,0.5)", position: "absolute", top: 1, left: 1,
    transition: "transform .18s cubic-bezier(.2,.8,.2,1)",
    boxShadow: "0 3px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.4)"
  },

  button: {
    cursor: "pointer", border: "1px solid rgba(70,45,25,0.6)", borderRadius: 12,
    padding: "10px 14px", fontWeight: 800, fontSize: 13, color: "#2a1c10",
    boxShadow: "0 6px 16px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.4)",
    background: "#b77d56"
  },

  lamp: { display: "grid", gridTemplateColumns: "auto auto", gap: 6, alignItems: "center" },
  lampDot: { width: 12, height: 12, borderRadius: "50%" },
  lampLabel: { color: "#3a2a1a", fontSize: 11, letterSpacing: 1, fontFamily: "Georgia,serif" },
};

const decor = {
  screw: {
    position: "absolute", width: 18, height: 18, borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, #b6b0a7, #6c655c 60%, #3b362f)",
    border: "1px solid #2a2621",
    boxShadow: "0 8px 20px rgba(0,0,0,0.5), inset 0 3px 8px rgba(0,0,0,0.6)"
  }
};
