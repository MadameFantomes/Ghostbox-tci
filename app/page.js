"use client";

/**
 * Ghostbox TCI — FR
 * - Scan & radio INCHANGÉS (bruit/burst originaux)
 * - UI vintage + curseurs
 * - MODE KÖNIG audible (parallèle, intensité réglable)
 * - Enregistrement MP3 prioritaire (MediaRecorder → lamejs CDN → webm)
 * - Correctif anti-buffer loop (“mouai”) sur changement de station
 * - LOG minimal + BroadcastChannel
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

function safeHost(url) { try { return new URL(url).host; } catch { return "station"; } }

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

  // Bus somme (pour KÖNIG + enregistrement lamejs)
  const sumRef = useRef(null);

  // ------- MODE KÖNIG (parallèle) -------
  const [kng, setKng] = useState(false);
  const [kngAmt, setKngAmt] = useState(0.7);
  const kngProcRef = useRef(null);     // ScriptProcessor (ring-mod + LPF)
  const kngWetRef = useRef(null);      // gain du signal traité
  const kngOscBusRef = useRef(null);   // bus multi-porteuses
  const kngOscListRef = useRef([]);    // oscillateurs + LFOs
  const kngEnabledRef = useRef(false);
  const kngLORef = useRef({ f: 5500, p: 0 });

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

  // Contrôles (sliders)
  const [vitesse, setVitesse] = useState(0.45); // 250..2500 ms
  const [volume, setVolume] = useState(0.9);
  const [echo, setEcho] = useState(0.3); // mix + fb
  const [debit, setDebit] = useState(0.4); // plus doux par défaut

  // Enregistrement
  const [enr, setEnr] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);

  // MP3 via lamejs (CDN)
  const tapProcRef = useRef(null);
  const mp3EncoderRef = useRef(null);
  const mp3ChunksRef = useRef([]);

  // ------- LOG minimal -------
  const logRef = useRef([]);
  const bcRef = useRef(null);

  // Helpers
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const msFromSpeed = (v) => Math.round(250 + v * (2500 - 250)); // 250..2500
  const BASE_NOISE = 0.006; // bruit de fond très faible (ORIGINAL)
  const burstMs = () => Math.round(120 + debit * 520); // 120..640 ms
  const burstGain = () => Math.min(0.4, 0.08 + debit * 0.32); // plafonné à ~0.40
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------- LOG setup -------
  useEffect(() => {
    try { bcRef.current = new BroadcastChannel("labo-ghostbox"); } catch {}
    return () => { try { bcRef.current?.close(); } catch {} };
  }, []);
  function addLog(event, extra = {}) {
    const entry = { timestamp: new Date().toISOString(), event, vitesse, volume, debit, echo, kng, kngAmt, station: stationsRef.current[idxRef.current]?.name || null, ...extra };
    logRef.current.push(entry);
    try {
      const key = "ghostbox.logs";
      const prev = JSON.parse(localStorage.getItem(key) || "[]");
      prev.push(entry); localStorage.setItem(key, JSON.stringify(prev));
    } catch {}
    try { bcRef.current?.postMessage(entry); } catch {}
  }
  function exportLog() {
    try {
      const blob = new Blob([JSON.stringify(logRef.current, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob); const a = document.createElement("a");
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
      try { url = url.trim(); list.push({ name: (name && name.trim()) || safeHost(url) + suffix, url }); } catch {}
    };
    if (Array.isArray(json)) {
      json.forEach((s) => {
        if (!s) return; if (s.url) push(s.name, s.url);
        if (Array.isArray(s.urls)) s.urls.forEach((u, k) => push(s.name, u, ` #${k + 1}`));
      });
    } else if (json && typeof json === "object") {
      Object.entries(json).forEach(([group, arr]) => {
        if (!Array.isArray(arr)) return;
        arr.forEach((s) => {
          if (!s) return; if (s.url) push(s.name || group, s.url);
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
    const fb = ctx.createGain(); fb.gain.value = 0.25; dly.connect(fb); fb.connect(dly);
    const wet = ctx.createGain(); wet.gain.value = 0; echoDelayRef.current = dly; echoFbRef.current = fb; echoWetRef.current = wet;

    // “clic”
    const clickBus = ctx.createGain(); clickBus.gain.value = 0; clickBus.connect(master); clickBusRef.current = clickBus;

    // Somme → master (référence pour KÖNIG + tap lamejs)
    const sum = ctx.createGain(); sum.gain.value = 1; sumRef.current = sum;

    // bruit : noise → HP → BP → LP → gNoise → sum
    noise.connect(hpN); hpN.connect(bp); bp.connect(lpN); lpN.connect(gNoise); gNoise.connect(sum);

    // radio → gRadio → sum (le chaînage radio réel arrive dans attachMedia)
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

      attachMedia._cleanup = () => {
        el.removeEventListener("playing", duckToFloor);
        el.removeEventListener("timeupdate", duckToFloor);
      };

      setCompat(false);
    } catch {
      setCompat(true); // CORS : pas de traitement possible
    }
  }

  // ------- MODE KÖNIG (audible, parallèle) -------
  function koenigEnable() {
    if (kngEnabledRef.current) return;
    const ctx = ctxRef.current; if (!ctx || !sumRef.current || !masterRef.current) return;

    // 1) Ring-mod 5.5 kHz + LPF ~2.4 kHz
    const proc = ctx.createScriptProcessor(1024, 2, 2);
    const wet = ctx.createGain(); wet.gain.value = 0;
    const lo = kngLORef.current; lo.f = 5500; lo.p = 0;

    const fc = 2400; const alpha = 1 - Math.exp(-2 * Math.PI * fc / ctx.sampleRate);
    let yL = 0, yR = 0;

    proc.onaudioprocess = (ev) => {
      const iL = ev.inputBuffer.getChannelData(0);
      const iR = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : iL;
      const oL = ev.outputBuffer.getChannelData(0);
      const oR = ev.outputBuffer.numberOfChannels > 1 ? ev.outputBuffer.getChannelData(1) : oL;

      const inc = (2 * Math.PI * lo.f) / ctx.sampleRate;
      let phase = lo.p;

      for (let n = 0; n < iL.length; n++) {
        const s = Math.sin(phase); phase += inc; if (phase > 1e9) phase %= (2 * Math.PI);
        const mL = iL[n] * s, mR = iR[n] * s;
        yL = yL + alpha * (mL - yL); yR = yR + alpha * (mR - yR);
        oL[n] = yL; oR[n] = yR;
      }
      lo.p = phase;
    };

    sumRef.current.connect(proc); proc.connect(wet); wet.connect(masterRef.current);
    kngProcRef.current = proc; kngWetRef.current = wet;

    // mix traité audible
    const amt = Math.max(0, Math.min(1, kngAmt || 0));
    const wetTarget = 0.10 + 0.18 * amt; // 0.10..0.28
    try { wet.gain.setTargetAtTime(wetTarget, ctx.currentTime, 0.15); } catch {}

    // 2) Multi-porteuses + battements
    const bus = ctx.createGain(); bus.gain.value = 0.015 + 0.045 * amt; // 0.015..0.06
    bus.connect(sumRef.current); kngOscBusRef.current = bus;

    const freqs = [1700, 2300, 3100, 5000, 8500];
    const oscList = [];
    freqs.forEach((f) => {
      const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.001 + 0.002 * amt; // 0.001..0.003
      osc.connect(g); g.connect(bus);

      const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 0.2 + Math.random() * 1.4;
      const lfoAmp = ctx.createGain(); lfoAmp.gain.value = 0.0006 + 0.0012 * amt;
      lfo.connect(lfoAmp); lfoAmp.connect(g.gain);

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

    try {
      kngWetRef.current?.gain?.setTargetAtTime(0, ctx.currentTime, 0.1);
      setTimeout(() => {
        try { sumRef.current?.disconnect(kngProcRef.current); } catch {}
        try { kngProcRef.current?.disconnect(); } catch {}
        kngProcRef.current = null; kngWetRef.current = null;
      }, 150);
    } catch {}

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
  useEffect(() => { if (!ctxRef.current) return; if (kng) koenigEnable(); else koenigDisable(); }, [kng]);
  useEffect(() => {
    const ctx = ctxRef.current; if (!ctx || !kngEnabledRef.current) return;
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
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i/d.length, 12);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = clickBusRef.current; const now = ctx.currentTime;
    try { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(level, now); g.gain.exponentialRampToValueAtTime(0.0001, now + dur); } catch {}
    src.connect(g); src.start();
  }

  // *** Helper anti-buffer loop ***
  function withNoCache(u) {
    try {
      const url = new URL(u);
      url.searchParams.set("nocache", Date.now().toString(36));
      if (!url.searchParams.has("icy-metadata")) url.searchParams.set("icy-metadata", "0");
      return url.toString();
    } catch {
      const sep = u.includes("?") ? "&" : "?";
      return `${u}${sep}nocache=${Date.now().toString(36)}&icy-metadata=0`;
    }
  }

  // *** Scan d’ORIGINE (inchangé) ***
  function playScanBurst(targetGain, durSec) {
    const ctx = ctxRef.current; if (!ctx) return;
    const now = ctx.currentTime;
    const bp = noiseFilterRef.current, hp = noiseHPRef.current, lp = noiseLPRef.current;
    const g = noiseGainRef.current?.gain;

    // couleur selon DÉBIT
    const q = 0.35 + debit * 0.45; // 0.35..0.80
    const lpF = 4200 + debit * 1600; // 4.2..5.8 kHz
    const hpF = 160 + debit * 180; // 160..340 Hz
    try {
      bp.Q.setTargetAtTime(q, now, 0.05);
      lp.frequency.setTargetAtTime(lpF, now, 0.08);
      hp.frequency.setTargetAtTime(hpF, now, 0.08);
    } catch {}

    // glissando + jitter doux
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

    // enveloppe modeste + “wobbles”
    try {
      g.cancelScheduledValues(now);
      const attack = Math.min(0.05, durSec * 0.22);
      g.setValueAtTime(BASE_NOISE, now);
      g.linearRampToValueAtTime(targetGain * (0.42 + 0.12*Math.random()), now + attack);
      const wobbleN = Math.max(2, Math.floor(durSec / 0.1));
      for (let i=1;i<=wobbleN;i++){
        const t = now + attack + (durSec - attack) * (i / wobbleN);
        const lvl = targetGain * (0.38 + 0.22*Math.random());
        g.linearRampToValueAtTime(lvl, t);
      }
    } catch {}
  }

  // ------- Lecture robuste (avec correctif anti-buffer) -------
  async function playIndex(startIndex, tries = 0) {
    const list = stationsRef.current; if (!list.length) return;
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

    // 1) clic + montée du bruit, radio vers 0
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

    // 2) charger / jouer (anti-mémoire tampon)
    try {
      el.crossOrigin = "anonymous";
      el.pause();

      // reset DUR du tag <audio> pour vider tout buffer
      try { el.srcObject = null; } catch {}
      try { el.removeAttribute("src"); } catch {}
      el.load();

      // cache-buster pour forcer un nouveau segment côté serveur
      const fresh = withNoCache(url);
      el.src = fresh;
      el.load();

      const playP = el.play();
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500));
      await Promise.race([playP, timeout]);

      // si le flux ne “avance” pas (boucle de buffer probable) → recharge une fois avec autre cache-buster
      const t0 = el.currentTime;
      setTimeout(() => {
        try {
          const progressed = Math.abs(el.currentTime - t0) > 0.05;
          if (!progressed && el.readyState >= 2) {
            el.pause();
            const again = withNoCache(url) + "&r=" + Math.random().toString(36).slice(2);
            el.src = again;
            el.load();
            el.play().catch(() => {});
          }
        } catch {}
      }, 1200);

      await attachMedia();
      applyAutoFilterProfile();

      // 3) retour : bruit → très bas, radio → 1
      const after = ctx.currentTime + Math.max(0.08, dur * 0.6);
      try {
        noiseGainRef.current.gain.setTargetAtTime(BASE_NOISE, after, 0.12);
        if (!compat) radioGainRef.current.gain.setTargetAtTime(1, after, 0.08);
        else el.volume = clamp01(volume);
      } catch {}

      idxRef.current = startIndex; setIdx(startIndex);
      setEtat(compat ? "lecture (compatibilité)" : "lecture");
      addLog("play_station", { url: fresh, compat });
    } catch {
      try { noiseGainRef.current.gain.setTargetAtTime(BASE_NOISE, ctx.currentTime + 0.05, 0.12); } catch {}
      const next = (startIndex + 1) % list.length;
      playingLockRef.current = false; await playIndex(next, tries + 1); return;
    }

    playingLockRef.current = false;
  }

  // ------- Balayage auto (inchangé) -------
  function startSweep() {
    stopSweep();
    const tick = async () => {
      if (!marche) return;
      const list = stationsRef.current; if (!list.length) return;
      const next = (idxRef.current + 1) % list.length;
      await playIndex(next);
      sweepTimerRef.current = setTimeout(tick, msFromSpeed(vitesse));
    };
    sweepTimerRef.current = setTimeout(tick, msFromSpeed(vitesse));
  }
  function stopSweep() { if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current); sweepTimerRef.current = null; }

  // ------- Enregistrement : MP3 natif → lamejs CDN → webm -------
  async function toggleEnr() {
    if (!ctxRef.current) await initAudio();
    if (!destRef.current) return;

    if (!enr) {
      // 1) MP3 natif ?
      let useNative = "MediaRecorder" in window && MediaRecorder.isTypeSupported?.("audio/mpeg");
      if (useNative) {
        let rec;
        try { rec = new MediaRecorder(destRef.current.stream, { mimeType: "audio/mpeg" }); }
        catch { rec = new MediaRecorder(destRef.current.stream); }
        chunksRef.current = [];
        rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
        rec.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a"); a.href = url; a.download = `ghostbox-${ts()}.mp3`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        };
        rec.start(); recRef.current = rec; setEnr(true); addLog("rec_start_native_mp3");
        return;
      }

      // 2) lamejs via CDN
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
        return;
      } catch {
        // 3) dernier recours : webm
        let rec;
        try { rec = new MediaRecorder(destRef.current.stream, { mimeType: "audio/webm;codecs=opus" }); }
        catch { rec = new MediaRecorder(destRef.current.stream); }
        chunksRef.current = [];
        rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
        rec.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a"); a.href = url; a.download = `ghostbox-${ts()}.webm`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        };
        rec.start(); recRef.current = rec; setEnr(true); addLog("rec_start_webm_fallback");
      }
    } else {
      // stop
      if (tapProcRef.current && mp3EncoderRef.current) {
        try {
          tapProcRef.current.disconnect(); tapProcRef.current.onaudioprocess = null; tapProcRef.current = null;
          const rest = mp3EncoderRef.current.flush(); if (rest && rest.length) mp3ChunksRef.current.push(new Int8Array(rest));
          const blob = new Blob(mp3ChunksRef.current, { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a"); a.href = url; a.download = `ghostbox-${ts()}.mp3`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        } catch {}
        mp3EncoderRef.current = null; mp3ChunksRef.current = [];
      } else {
        try { recRef.current?.stop(); } catch {}
      }
      setEnr(false); addLog("rec_stop");
    }
  }

  // --- utils encodage MP3 ---
  function f32ToI16(f32) {
    const out = new Int16Array(f32.length);
    for (let i=0;i<f32.length;i++){ const s = Math.max(-1, Math.min(1, f32[i])); out[i] = s<0 ? s*0x8000 : s*0x7fff; }
    return out;
  }
  function ts(){ return new Date().toISOString().replace(/[:.]/g,"-"); }
  function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.async=true; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
  async function loadLame(){
    if (typeof window!=="undefined" && (window.lamejs||window.Lame||window.lame)) return window.lamejs||window.Lame||window.lame;
    const cdns=[
      "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js",
      "https://unpkg.com/lamejs@1.2.1/lame.min.js",
    ];
    for (const url of cdns){ try{ await loadScript(url); break; } catch {} }
    const lib=window.lamejs||window.Lame||window.lame;
    if(!lib) throw new Error("lamejs introuvable");
    return lib;
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

          {/* En-tête vintage */}
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

          {/* Cadran / état */}
          <div style={styles.glass}>
            <div style={styles.stationRow}>
              <div><strong>{currentName || "—"}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && (<div style={styles.compatBanner}>Compat CORS : traitement radio limité</div>)}
          </div>

          {/* Commandes : switches + sliders */}
          <div style={styles.controlsRow}>
            <div style={styles.switches}>
              <Switch label="MARCHE" on={marche} onChange={async (v)=>{ setMarche(v); if (v) await powerOn(); else await powerOff(); }} />
              <Switch label="BALAYAGE AUTO" on={auto} onChange={(v)=>{ setAuto(v); addLog(v ? "auto_on" : "auto_off"); }} />
              <Switch label="MODE KÖNIG" on={kng} onChange={(v)=> setKng(v)} />
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Bouton label={enr ? "STOP ENREG." : "ENREGISTRER"} onClick={()=>{ toggleEnr(); addLog(enr ? "rec_stop" : "rec_start"); }} color={enr ? "#f0c14b" : "#c76d4b"} />
                <Bouton label="Exporter log" onClick={exportLog} color="#e7dcc6" />
              </div>
            </div>

            <div style={styles.sliders}>
              <Slider label="VITESSE" value={vitesse} onChange={(v)=> setVitesse(clamp01(v))} hint={`${msFromSpeed(vitesse)} ms`} />
              <Slider label="VOLUME" value={volume} onChange={(v)=> setVolume(clamp01(v))} />
              <Slider label="ÉCHO" value={echo} onChange={(v)=> setEcho(clamp01(v))} />
              <Slider label="DÉBIT" value={debit} onChange={(v)=> setDebit(clamp01(v))} hint={`${burstMs()} ms de bruit`} />
              {kng && <Slider label="KÖNIG NIVEAU" value={kngAmt} onChange={(v)=> setKngAmt(Math.max(0, Math.min(1, v)))} />}
            </div>
          </div>

          {/* Grille HP rétro */}
          <div style={styles.speakerGrille} />

          <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
        </div>

        <Vis at="tl" /><Vis at="tr" /><Vis at="bl" /><Vis at="br" />
      </div>

      <p style={{ color: "rgba(60,40,20,0.85)", marginTop: 10, fontSize: 12 }}>
        Scan d’origine conservé • Mode KÖNIG (parallèle) • Enregistrement MP3 • Anti-boucle de buffer actif.
      </p>
    </main>
  );
}

/* ------- Slider fluide ------- */
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
        onPointerDown={(e)=>{ e.currentTarget.setPointerCapture(e.pointerId); setDrag(true); setFromClientX(e.clientX); }}
        onPointerMove={(e)=>{ if (drag) setFromClientX(e.clientX); }}
        onPointerUp={()=> setDrag(false)}
        onPointerCancel={()=> setDrag(false)}
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
    <div style={ui.switchBlock} onClick={()=> onChange(!on)}>
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
      <div style={{ ...ui.lampDot, background: on ? colorOn : "#5a4a3f", boxShadow: on ? "0 0 14px rgba(134,251,106,0.55)" : "inset 0 0 4px rgba(0,0,0,0.5)" }} />
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

  glass: { borderRadius: 14, border: "1px solid rgba(76,56,36,0.6)", background: "linear-gradient(180deg, rgba(255,236,200,0.7), rgba(230,200,160,0.8))", padding: 10, position: "relative", overflow: "hidden", boxShadow: "inset 0 0 26px rgba(0,0,0,0.35)" },
  stationRow: { display: "flex", justifyContent: "space-between", color: "#3a2a1a", fontSize: 13, padding: "2px 2px" },
  compatBanner: { position: "absolute", right: 10, bottom: 10, background: "rgba(240,180,60,0.18)", border: "1px solid rgba(240,180,60,0.35)", color: "#7a5418", padding: "6px 10px", borderRadius: 8, fontSize: 12 },

  controlsRow: { marginTop: 14, display: "grid", gridTemplateColumns: "1fr 2fr", gap: 14, alignItems: "center" },
  switches: { display: "grid", gap: 10, alignContent: "start" },

  sliders: { display: "grid", gridTemplateColumns: "repeat(4, minmax(200px, 1fr))", gap: 16, alignItems: "center", justifyItems: "center" },

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
