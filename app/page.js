"use client";

/**
 * Ghostbox TCI — FR (scan original + MODE KÖNIG audible en parallèle)
 * - Bruit de fond discret (identique)
 * - Burst de balayage adouci + plafonné (identique)
 * - Ducking auto du bruit quand la radio joue (identique)
 * - Enregistrement .webm (identique)
 * - Filtre radio “TCI” auto si WebAudio autorisé (identique)
 * - Charge /public/stations.json sinon fallback (identique)
 * - LOG minimal (identique)
 * - + MODE KÖNIG : ring-mod 5.5 kHz + porteuses, mix parallèle, intensité réglable
 */

import React, { useEffect, useRef, useState } from "react";

const AUTO_FILTER = true;

// ------- Fallback -------
const FALLBACK_STATIONS = [
  "https://icecast.radiofrance.fr/fip-midfi.mp3",
  "https://icecast.radiofrance.fr/fiprock-midfi.mp3",
  "https://icecast.radiofrance.fr/fipjazz-midfi.mp3",
  "https://icecast.radiofrance.fr/fipgroove-midfi.mp3",
  "https://stream.srg-ssr.ch/srgssr/rsj/aac/96",
  "https://stream.srg-ssr.ch/srgssr/rsc/aac/96",
  "https://stream.srg-ssr.ch/srgssr/rsp/aac/96",
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

  // Radio FX (auto-filtre “TCI”)
  const radioHPRef = useRef(null);
  const radioLPRef = useRef(null);
  const radioShelfRef = useRef(null);
  const driveRef = useRef(null);

  // Mix & Écho
  const dryRef = useRef(null);
  const echoDelayRef = useRef(null);
  const echoFbRef = useRef(null);
  const echoWetRef = useRef(null);

  // “clic” de commutation
  const clickBusRef = useRef(null);

  // Bus de somme (pour traitements parallèles type KÖNIG)
  const sumRef = useRef(null);

  // ------- MODE KÖNIG -------
  const [kng, setKng] = useState(false);
  const [kngAmt, setKngAmt] = useState(0.7); // intensité 0..1 (par défaut assez audible)
  const kngProcRef = useRef(null);     // ScriptProcessor (ring-mod + LPF)
  const kngWetRef = useRef(null);      // gain du signal traité
  const kngOscBusRef = useRef(null);   // bus multi-porteuses
  const kngOscListRef = useRef([]);    // oscillateurs + LFOs
  const kngEnabledRef = useRef(false);
  const kngLORef = useRef({ f: 5500, p: 0 }); // 5.5 kHz, phase en mémoire

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
  const sweepTimerRef = useRef(null);
  const playingLockRef = useRef(false);

  // Contrôles
  const [vitesse, setVitesse] = useState(0.45); // 250..2500 ms
  const [volume, setVolume] = useState(0.9);
  const [echo, setEcho] = useState(0.3); // mix + fb
  const [debit, setDebit] = useState(0.4); // plus doux par défaut

  // Enregistrement
  const [enr, setEnr] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);

  // ------- LOG minimal -------
  const logRef = useRef([]);
  const bcRef = useRef(null); // BroadcastChannel

  // Helpers
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const msFromSpeed = (v) => Math.round(250 + v * (2500 - 250)); // 250..2500
  const BASE_NOISE = 0.006; // bruit de fond très faible (== original)
  const burstMs = () => Math.round(120 + debit * 520); // 120..640 ms
  const burstGain = () => Math.min(0.4, 0.08 + debit * 0.32); // plafonné à ~0.40
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------- LOG setup -------
  useEffect(() => {
    try { bcRef.current = new BroadcastChannel("labo-ghostbox"); } catch {}
    return () => { try { bcRef.current?.close(); } catch {} };
  }, []);

  function addLog(event, extra = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      event, vitesse, volume, debit, echo, kng, kngAmt,
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
      a.href = url;
      a.download = `ghostbox-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch {}
  }

  // ------- Charger /stations.json -------
  useEffect(() => { (async () => {
    try {
      const r = await fetch("/stations.json", { cache: "no-store" });
      if (!r.ok) throw new Error();
      const flat = normalizeStationsJson(await r.json());
      if (flat.length) {
        setStations(flat);
        stationsRef.current = flat;
        idxRef.current = 0;
        setIdx(0);
      }
    } catch { stationsRef.current = FALLBACK_STATIONS; }
  })(); }, []);

  function normalizeStationsJson(json) {
    let list = [];
    const push = (name, url, suffix = "") => {
      if (!url || typeof url !== "string") return;
      if (!/^https:/i.test(url)) return; // https only
      try { url = url.trim(); list.push({ name: (name && name.trim()) || safeHost(url) + suffix, url }); } catch {}
    };
    if (Array.isArray(json)) {
      json.forEach((s) => {
        if (!s) return;
        if (s.url) push(s.name, s.url);
        if (Array.isArray(s.urls)) s.urls.forEach((u, k) => push(s.name, u, ` #${k + 1}`));
      });
    } else if (json && typeof json === "object") {
      Object.entries(json).forEach(([group, arr]) => {
        if (!Array.isArray(arr)) return;
        arr.forEach((s) => {
          if (!s) return;
          if (s.url) push(s.name || group, s.url);
          if (Array.isArray(s.urls)) s.urls.forEach((u, k) => push(s.name || group, u, ` #${k + 1}`));
        });
      });
    }
    const seen = new Set();
    list = list.filter((s) => (seen.has(s.url) ? false : seen.add(s.url)));
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  }

  // ------- Init WebAudio -------
  async function initAudio() {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxRef.current = ctx;

    // Master
    const master = ctx.createGain(); master.gain.value = clamp01(volume); master.connect(ctx.destination); masterRef.current = master;

    // Enregistrement
    const dest = ctx.createMediaStreamDestination(); master.connect(dest); destRef.current = dest;

    // Radio
    const gRadio = ctx.createGain(); gRadio.gain.value = 1; radioGainRef.current = gRadio;

    // Bruit (HP→BP→LP→Gain)
    const noise = createNoiseNode(ctx); noiseNodeRef.current = noise;

    const hpN = ctx.createBiquadFilter(); hpN.type = "highpass"; hpN.frequency.value = 160; hpN.Q.value = 0.7;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.55; bp.frequency.value = 1800;
    const lpN = ctx.createBiquadFilter(); lpN.type = "lowpass"; lpN.frequency.value = 5200; lpN.Q.value = 0.3; // un peu plus sombre

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
    const fb = ctx.createGain(); fb.gain.value = 0.25; dly.connect(fb); fb.connect(dly);

    const wet = ctx.createGain(); wet.gain.value = 0;

    echoDelayRef.current = dly; echoFbRef.current = fb; echoWetRef.current = wet;

    // “clic”
    const clickBus = ctx.createGain(); clickBus.gain.value = 0; clickBus.connect(master); clickBusRef.current = clickBus;

    // Somme → master (référence pour traitements parallèles)
    const sum = ctx.createGain(); sum.gain.value = 1; sumRef.current = sum;

    // bruit : noise → HP → BP → LP → gNoise → sum
    noise.connect(hpN); hpN.connect(bp); bp.connect(lpN); lpN.connect(gNoise); gNoise.connect(sum);

    // radio → (filtre si activé) → gRadio → sum
    // (chaînage réel dans attachMedia)
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

  // légère saturation
  function createDriveNode(ctx, amount = 0.25) {
    const ws = ctx.createWaveShaper(); ws.curve = makeDistortionCurve(amount); ws.oversample = "4x"; return ws;
  }
  function makeDistortionCurve(amount = 0.25) {
    const k = amount * 100, n = 44100, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    return curve;
  }

  function applyAutoFilterProfile() {
    const ctx = ctxRef.current;
    if (!AUTO_FILTER || !ctx || !radioHPRef.current) return;
    const now = ctx.currentTime;
    const hpF = 260 + Math.random() * 160; // 260..420 Hz
    const lpF = 2800 + Math.random() * 1400; // 2.8..4.2 kHz
    const shelfGain = -(2 + Math.random() * 5); // -2..-7 dB
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
    if (mediaSrcRef.current) return; // déjà relié
    try {
      const src = ctxRef.current.createMediaElementSource(audioElRef.current);
      mediaSrcRef.current = src;

      if (AUTO_FILTER && radioHPRef.current) {
        // src → HP → LP → Shelf → Drive → gRadio
        src.connect(radioHPRef.current);
        radioHPRef.current.connect(radioLPRef.current);
        radioLPRef.current.connect(radioShelfRef.current);
        radioShelfRef.current.connect(driveRef.current);
        driveRef.current.connect(radioGainRef.current);
      } else {
        src.connect(radioGainRef.current);
      }

      // ducking du bruit quand la radio joue
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

      // cleanup pour powerOff
      attachMedia._cleanup = () => {
        el.removeEventListener("playing", duckToFloor);
        el.removeEventListener("timeupdate", duckToFloor);
      };

      setCompat(false);
    } catch {
      setCompat(true); // CORS : pas de traitement possible
    }
  }

  // ------- MODE KÖNIG (parallèle, plus audible) -------
  function koenigEnable() {
    if (kngEnabledRef.current) return;
    const ctx = ctxRef.current; if (!ctx || !sumRef.current || !masterRef.current) return;

    // 1) Ring-mod (5.5 kHz) + LPF simple (≈2.4 kHz) dans un ScriptProcessor
    const proc = ctx.createScriptProcessor(1024, 2, 2);
    const wet = ctx.createGain(); wet.gain.value = 0; // on animera ensuite
    const lo = kngLORef.current; lo.f = 5500; // “porteuse” haute
    const fc = 2400; const alpha = 1 - Math.exp(-2 * Math.PI * fc / ctx.sampleRate);
    let yL = 0, yR = 0;

    proc.onaudioprocess = (ev) => {
      const iL = ev.inputBuffer.getChannelData(0);
      const iR = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : iL;
      const oL = ev.outputBuffer.getChannelData(0);
      const oR = ev.outputBuffer.numberOfChannels > 1 ? ev.outputBuffer.getChannelData(1) : oL;
      const inc = 2 * Math.PI * lo.f / ctx.sampleRate;
      let phase = lo.p;

      for (let n = 0; n < iL.length; n++) {
        const s = Math.sin(phase); phase += inc; if (phase > 1e9) phase %= (2 * Math.PI);
        const mL = iL[n] * s, mR = iR[n] * s; // ring-mod
        yL = yL + alpha * (mL - yL); yR = yR + alpha * (mR - yR); // LPF
        oL[n] = yL; oR[n] = yR;
      }
      lo.p = phase;
    };

    sumRef.current.connect(proc); proc.connect(wet); wet.connect(masterRef.current);
    kngProcRef.current = proc; kngWetRef.current = wet;

    // mix traité (audible) selon kngAmt
    const amt = Math.max(0, Math.min(1, kngAmt || 0));
    const wetTarget = 0.10 + 0.18 * amt; // 0.10..0.28
    try { wet.gain.setTargetAtTime(wetTarget, ctx.currentTime, 0.15); } catch {}

    // 2) Multi-porteuses + battements (bus qui revient AVANT dry/master pour interagir avec bruit/radio)
    const bus = ctx.createGain(); bus.gain.value = 0.015 + 0.045 * amt; // 0.015..0.06
    bus.connect(sumRef.current); kngOscBusRef.current = bus;

    const freqs = [1700, 2300, 3100, 5000, 8500];
    const oscList = [];
    freqs.forEach((f) => {
      const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.001 + 0.002 * amt; // 0.001..0.003
      osc.connect(g); g.connect(bus);

      // LFO lent (0.2..1.6 Hz) pour donner vie
      const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 0.2 + Math.random() * 1.4;
      const lfoAmp = ctx.createGain(); lfoAmp.gain.value = 0.0006 + 0.0012 * amt;
      lfo.connect(lfoAmp); lfoAmp.connect(g.gain);

      // Offset DC léger (niveau constant bas)
      const base = ctx.createConstantSource(); base.offset.value = 0.0006 + 0.0012 * amt;
      base.connect(g.gain); base.start();

      try { osc.start(); lfo.start(); } catch {}
      oscList.push({ osc, g, lfo, lfoAmp, base });
    });
    kngOscListRef.current = oscList;

    kngEnabledRef.current = true; addLog("koenig_on");
  }

  function koenigDisable() {
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

    kngEnabledRef.current = false; addLog("koenig_off");
  }

  useEffect(() => { if (!ctxRef.current) return; if (kng) koenigEnable(); else koenigDisable(); /* eslint-disable-next-line */ }, [kng]);
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !kngEnabledRef.current) return;
    try {
      const amt = Math.max(0, Math.min(1, kngAmt || 0));
      kngWetRef.current?.gain?.setTargetAtTime(0.10 + 0.18 * amt, ctx.currentTime, 0.08);
      if (kngOscBusRef.current) kngOscBusRef.current.gain.setTargetAtTime(0.015 + 0.045 * amt, ctx.currentTime, 0.08);
    } catch {}
  }, [kngAmt]);

  // ------- Power -------
  async function powerOn() {
    await initAudio();
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    try { noiseGainRef.current.gain.value = BASE_NOISE; } catch {}
    addLog("power_on");
    await playIndex(idxRef.current);
    setMarche(true);
  }

  async function powerOff() {
    stopSweep();
    const el = audioElRef.current;
    try { noiseGainRef.current.gain.value = 0; } catch {}
    if (el) { el.pause(); el.src = ""; el.load(); }
    if (attachMedia._cleanup) attachMedia._cleanup();
    if (enr) { try { recRef.current?.stop(); } catch {} setEnr(false); }
    try { await ctxRef.current?.suspend(); } catch {}
    setMarche(false); setAuto(false); setEtat("arrêté"); playingLockRef.current = false; addLog("power_off");
  }

  // petit “clic” discret
  function triggerClick(level = 0.28) {
    const ctx = ctxRef.current; if (!ctx || !clickBusRef.current) return;
    const dur = 0.012;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(dur * ctx.sampleRate)), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 12);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = clickBusRef.current; const now = ctx.currentTime;
    try { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(level, now); g.gain.exponentialRampToValueAtTime(0.0001, now + dur); } catch {}
    src.connect(g); src.start();
  }

  // éclaboussure de bruit modulée (balayage) — **inchangé**
  function playScanBurst(targetGain, durSec) {
    const ctx = ctxRef.current; if (!ctx) return;
    const now = ctx.currentTime;
    const bp = noiseFilterRef.current, hp = noiseHPRef.current, lp = noiseLPRef.current;
    const g = noiseGainRef.current?.gain;

    // couleur selon DÉBIT (identique)
    const q = 0.35 + debit * 0.45; // 0.35..0.80
    const lpF = 4200 + debit * 1600; // 4.2..5.8 kHz
    const hpF = 160 + debit * 180; // 160..340 Hz
    try {
      bp.Q.setTargetAtTime(q, now, 0.05);
      lp.frequency.setTargetAtTime(lpF, now, 0.08);
      hp.frequency.setTargetAtTime(hpF, now, 0.08);
    } catch {}

    // glissando + jitter doux (identique)
    const fStart = 800 + Math.random() * 800; // 0.8–1.6 kHz
    const fMid = 1300 + Math.random() * 1500; // 1.3–2.8 kHz
    const fEnd = 1800 + Math.random() * 1800; // 1.8–3.6 kHz
    const steps = Math.max(4, Math.floor(durSec * 10));
    for (let i = 0; i <= steps; i++) {
      const t = now + (durSec * i) / steps;
      const x = i / steps;
      const f = x < 0.6 ? fStart + ((fMid - fStart) * x) / 0.6 : fMid + ((fEnd - fMid) * (x - 0.6)) / 0.4;
      const jitter = (Math.random() * 2 - 1) * (80 + 380 * (1 - debit));
      try { bp.frequency.linearRampToValueAtTime(Math.max(300, f + jitter), t); } catch {}
    }

    // enveloppe “wobble” (identique)
    try {
      g.cancelScheduledValues(now);
      const attack = Math.min(0.05, durSec * 0.22);
      g.setValueAtTime(BASE_NOISE, now);
      g.linearRampToValueAtTime(targetGain * (0.42 + 0.12 * Math.random()), now + attack);
      const wobbleN = Math.max(2, Math.floor(durSec / 0.1));
      for (let i = 1; i <= wobbleN; i++) {
        const t = now + attack + ((durSec - attack) * i) / wobbleN;
        const lvl = targetGain * (0.38 + 0.22 * Math.random());
        g.linearRampToValueAtTime(lvl, t);
      }
    } catch {}
  }

  // ------- Lecture robuste -------
  async function playIndex(startIndex, tries = 0) {
    const list = stationsRef.current;
    if (!list.length) return;
    if (tries >= list.length) { setEtat("aucun flux lisible"); return; }
    if (playingLockRef.current) return;
    playingLockRef.current = true;

    const el = audioElRef.current;
    const entry = list[startIndex];
    const url = typeof entry === "string" ? entry : entry.url;
    const ctx = ctxRef.current;
    const now = ctx.currentTime;
    const dur = burstMs() / 1000;
    const targetNoise = burstGain();

    // 1) clic + montée du bruit, radio vers 0 (identique)
    triggerClick();
    try {
      if (!compat) {
        radioGainRef.current.gain.cancelScheduledValues(now);
        radioGainRef.current.gain.linearRampToValueAtTime(0.0001, now + 0.05);
      } else {
        el.volume = 0;
      }
    } catch {}

    playScanBurst(targetNoise, dur);
    setEtat("balayage…");
    addLog("scan_burst", { targetNoise, dur });
    await sleep(Math.max(100, dur * 600));

    // 2) charger / jouer (identique)
    try {
      el.crossOrigin = "anonymous";
      el.pause();
      el.src = url;
      el.load();

      const playP = el.play();
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500));
      await Promise.race([playP, timeout]);

      await attachMedia();
      applyAutoFilterProfile();

      // 3) retour : bruit → très bas, radio → 1 (identique)
      const after = ctx.currentTime + Math.max(0.08, dur * 0.6);
      try {
        noiseGainRef.current.gain.setTargetAtTime(BASE_NOISE, after, 0.12);
        if (!compat) radioGainRef.current.gain.setTargetAtTime(1, after, 0.08);
        else el.volume = clamp01(volume);
      } catch {}

      idxRef.current = startIndex;
      setIdx(startIndex);
      setEtat(compat ? "lecture (compatibilité)" : "lecture");
      addLog("play_station", { url, compat });
    } catch {
      try { noiseGainRef.current.gain.setTargetAtTime(BASE_NOISE, ctx.currentTime + 0.05, 0.12); } catch {}
      const next = (startIndex + 1) % list.length;
      playingLockRef.current = false;
      await playIndex(next, tries + 1);
      return;
    }

    playingLockRef.current = false;
  }

  // ------- Balayage auto -------
  function startSweep() {
    stopSweep();
    const tick = async () => {
      if (!marche) return;
      const list = stationsRef.current;
      if (!list.length) return;
      const next = (idxRef.current + 1) % list.length;
      await playIndex(next);
      sweepTimerRef.current = setTimeout(tick, msFromSpeed(vitesse));
    };
    sweepTimerRef.current = setTimeout(tick, msFromSpeed(vitesse));
  }
  function stopSweep() { if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current); sweepTimerRef.current = null; }

  // ------- Enregistrement (identique) -------
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
        a.href = url;
        a.download = `ghostbox-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
      };
      rec.start(); recRef.current = rec; setEnr(true);
    } else {
      try { recRef.current?.stop(); } catch {}
      setEnr(false);
    }
  }

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
  }, [auto, vitesse, marche]);

  /* ------- UI ------- */
  const list = stationsRef.current;
  const current = list[idxRef.current];
  const currentName = current?.name || (current?.url ? safeHost(current.url) : "");

  return (
    <main style={styles.page}>
      <div style={styles.shadowWrap}>
        <div style={styles.cabinet}>
          <div style={styles.textureOverlay} />

          {/* En-tête */}
          <div style={styles.headerBar}>
            <div style={styles.brandPlate}>
              <div style={styles.brandText}>MADAME FANTÔMES</div>
              <div style={styles.brandSub}>Ghostbox • Formation TCI</div>
            </div>
            <div style={styles.rightHeader}>
              <div style={styles.lampsRow}>
                <Lamp label="MARCHE" on={marche} />
                <Lamp label="AUTO" on={auto} colorOn="#86fb6a" />
                <Lamp label="ENR" on={enr} colorOn="#ff5656" />
                <Lamp label="KÖNIG" on={kng} colorOn="#7cc7ff" />
              </div>
            </div>
          </div>

          {/* Cadran / état */}
          <div style={styles.glass}>
            <div style={styles.stationRow}>
              <div><strong>{currentName || "—"}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && (<div style={styles.compatBanner}>Compat CORS : traitement radio limité</div>)}
          </div>

          {/* Contrôles */}
          <div style={styles.controlsRow}>
            <div style={styles.switches}>
              <Switch
                label="MARCHE"
                on={marche}
                onChange={async (v) => { setMarche(v); if (v) await powerOn(); else await powerOff(); }}
              />
              <Switch
                label="BALAYAGE AUTO"
                on={auto}
                onChange={(v) => { setAuto(v); addLog(v ? "auto_on" : "auto_off"); }}
              />
              <Switch
                label="MODE KÖNIG"
                on={kng}
                onChange={(v) => setKng(v)}
              />
              <Bouton
                label={enr ? "STOP ENREG." : "ENREGISTRER"}
                onClick={() => { toggleEnr(); addLog(enr ? "rec_stop" : "rec_start"); }}
                color={enr ? "#f0c14b" : "#d96254"}
              />
              <Bouton label="Exporter log" onClick={exportLog} color="#e2d9c6" />
            </div>

            <div style={styles.knobs}>
              <Knob label="VITESSE" value={vitesse} onChange={(v) => setVitesse(clamp01(v))} hint={`${msFromSpeed(vitesse)} ms`} />
              <Knob label="VOLUME" value={volume} onChange={(v) => setVolume(clamp01(v))} />
              <Knob label="ÉCHO" value={echo} onChange={(v) => setEcho(clamp01(v))} />
              <Knob label="DÉBIT" value={debit} onChange={(v) => setDebit(clamp01(v))} hint={`${burstMs()} ms de bruit`} />
              {kng && <Knob label="KÖNIG" value={kngAmt} onChange={(v) => setKngAmt(clamp01(v))} />}
            </div>
          </div>

          <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
        </div>

        <Vis at="tl" /><Vis at="tr" /><Vis at="bl" /><Vis at="br" />
      </div>

      <p style={{ color: "rgba(255,255,255,0.8)", marginTop: 10, fontSize: 12 }}>
        Scan d’origine conservé • MODE KÖNIG en parallèle (plus audible) • Radio et écho inchangés.
      </p>
    </main>
  );
}

/* ------- UI widgets ------- */
function Knob({ label, value, onChange, hint }) {
  const [drag, setDrag] = useState(null);
  const angle = -135 + value * 270;
  return (
    <div style={ui.knobBlock}>
      <div
        style={{ ...ui.knob, transform: `rotate(${angle}deg)` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ y: e.clientY, v: value }); }}
        onPointerMove={(e) => { if (!drag) return; const d = (drag.y - e.clientY) / 220; onChange(drag.v + d); }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
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
  const pos = { tl: { top: -8, left: -8 }, tr: { top: -8, right: -8 }, bl: { bottom: -8, left: -8 }, br: { bottom: -8, right: -8 } }[at] || {};
  return <div style={{ ...decor.screw, ...pos }} />;
}

/* ------- Styles ------- */
const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg,#1b2432 0%,#0f1723 60%,#0a0f18 100%)",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },
  shadowWrap: { position: "relative" },
  cabinet: {
    width: "min(980px, 94vw)",
    borderRadius: 26,
    padding: 16,
    border: "1px solid rgba(48,42,36,0.55)",
    boxShadow: "0 30px 88px rgba(0,0,0,0.65), inset 0 0 0 1px rgba(255,255,255,0.04)",
    backgroundImage: "url('/skin-watercolor.svg')",
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundBlendMode: "multiply",
    position: "relative",
    overflow: "hidden",
  },
  textureOverlay: {
    position: "absolute", inset: 0, pointerEvents: "none",
    background:
      "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.06), rgba(255,255,255,0) 60%)," +
      "radial-gradient(circle at 70% 70%, rgba(0,0,0,0.12), rgba(0,0,0,0) 55%)",
  },
  headerBar: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  brandPlate: { background: "linear-gradient(180deg,#2a2f36,#1c2129)", color: "#efe6d2", borderRadius: 12, border: "1px solid #2a2e36", padding: "10px 14px", boxShadow: "inset 0 0 20px rgba(0,0,0,0.45)" },
  brandText: { fontFamily: "Georgia,serif", fontWeight: 800, letterSpacing: 1.5, fontSize: 14 },
  brandSub: { fontFamily: "Georgia,serif", fontSize: 12, opacity: 0.8 },
  rightHeader: { display: "flex", alignItems: "center", gap: 12 },
  lampsRow: { display: "flex", gap: 14, alignItems: "center" },
  glass: { borderRadius: 16, border: "1px solid rgba(35,45,60,0.9)", background: "linear-gradient(180deg, rgba(168,201,210,0.55), rgba(58,88,110,0.6))", padding: 12, position: "relative", overflow: "hidden", boxShadow: "inset 0 0 32px rgba(0,0,0,0.55)" },
  stationRow: { display: "flex", justifyContent: "space-between", color: "#f3efe6", fontSize: 13, padding: "2px 2px" },
  compatBanner: { position: "absolute", right: 10, bottom: 10, background: "rgba(240,180,60,0.18)", border: "1px solid rgba(240,180,60,0.35)", color: "#f0c572", padding: "6px 10px", borderRadius: 8, fontSize: 12 },
  controlsRow: { marginTop: 16, display: "grid", gridTemplateColumns: "1fr 2fr", gap: 14, alignItems: "center" },
  switches: { display: "grid", gap: 10, alignContent: "start" },
  knobs: { display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 14, alignItems: "center", justifyItems: "center" },
};

const ui = {
  knobBlock: { display: "grid", justifyItems: "center" },
  knob: {
    width: 100, height: 100, borderRadius: "50%",
    background: "radial-gradient(circle at 32% 28%, #6d6f79, #3a3f4a 62%, #1b2230 100%)",
    border: "1px solid rgba(28,30,38,0.9)",
    boxShadow: "inset 0 12px 30px rgba(0,0,0,0.55), 0 8px 26px rgba(0,0,0,0.45)",
    display: "grid", placeItems: "center", touchAction: "none", userSelect: "none", cursor: "grab",
  },
  knobIndicator: { width: 8, height: 34, borderRadius: 4, background: "#e1b66f", boxShadow: "0 0 10px rgba(225,182,111,0.45)" },
  knobLabel: { color: "#f0eadc", marginTop: 6, fontSize: 13, letterSpacing: 1.2, textAlign: "center", fontFamily: "Georgia,serif" },
  hint: { color: "rgba(255,255,255,0.7)", fontSize: 11, marginTop: 2 },
  switchBlock: { display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 10, cursor: "pointer" },
  switchLabel: { color: "#f0eadc", fontSize: 12, letterSpacing: 1.2, fontFamily: "Georgia,serif" },
  switch: { width: 64, height: 26, borderRadius: 16, position: "relative", border: "1px solid rgba(40,44,56,0.9)", background: "linear-gradient(180deg,#2a2f36,#20252d)" },
  switchDot: { width: 24, height: 24, borderRadius: "50%", background: "#10151c", border: "1px solid #2b2f39", position: "absolute", top: 1, left: 1, transition: "transform .15s" },
  button: { cursor: "pointer", border: "1px solid rgba(60,48,38,0.8)", borderRadius: 12, padding: "10px 14px", fontWeight: 800, fontSize: 13, color: "#0b0b10", boxShadow: "0 6px 18px rgba(0,0,0,0.35)", background: "#d96254" },
  lamp: { display: "grid", gridTemplateColumns: "auto auto", gap: 6, alignItems: "center" },
  lampDot: { width: 12, height: 12, borderRadius: "50%" },
  lampLabel: { color: "#efe6d2", fontSize: 11, letterSpacing: 1, fontFamily: "Georgia,serif" },
};

const decor = {
  screw: { position: "absolute", width: 18, height: 18, borderRadius: "50%", background: "radial-gradient(circle at 30% 30%, #9aa0ad, #4b515e 60%, #1e232d)", border: "1px solid #222834", boxShadow: "0 8px 20px rgba(0,0,0,0.5), inset 0 3px 8px rgba(0,0,0,0.6)" }
};
