"use client";

/**
 * Ghostbox TCI — FR
 * - Fusionne /public/stations.json + /public/stations-extra.json (dédoublonné)
 * - Balayage "direct" (HLS/playlist écartés) + live-edge forcé
 * - Bruit discret + ducking
 * - MICRO mixé au même fichier d’enregistrement (bus REC)
 * - ENREGISTRER : MP3 si supporté, sinon WAV
 * - Fallback CORS : captureStream() si MediaElementSource indisponible
 */

import React, { useEffect, useRef, useState } from "react";

const AUTO_FILTER = true;

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

  // Audio
  const ctxRef = useRef(null);
  const masterRef = useRef(null);        // vers HP
  const recordMixRef = useRef(null);     // bus REC (master + mic)
  const destRef = useRef(null);          // MediaStreamDestination (REC)

  // Sources
  const mediaSrcRef = useRef(null);      // node pour la radio (MediaElementSource OU captureStream source)
  const radioGainRef = useRef(null);

  // Micro
  const micSrcRef = useRef(null);
  const micGainRef = useRef(null);
  const micStreamRef = useRef(null);

  // Bruit
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

  // Écho
  const dryRef = useRef(null);
  const echoDelayRef = useRef(null);
  const echoFbRef = useRef(null);
  const echoWetRef = useRef(null);

  // Clic
  const clickBusRef = useRef(null);

  // Stations
  const [stations, setStations] = useState(FALLBACK_STATIONS);
  const stationsRef = useRef(FALLBACK_STATIONS);
  const [idx, setIdx] = useState(0);
  const idxRef = useRef(0);

  // UI
  const [etat, setEtat] = useState("prêt");
  const [marche, setMarche] = useState(false);
  const [auto, setAuto] = useState(false);
  const [compat, setCompat] = useState(false);  // compat = on lit sans traitement (si aucun ancrage au graphe)
  const [micOn, setMicOn] = useState(false);
  const [micErr, setMicErr] = useState("");
  const sweepTimerRef = useRef(null);
  const playingLockRef = useRef(false);

  // Contrôles
  const [vitesse, setVitesse] = useState(0.45);
  const [volume, setVolume]  = useState(0.9);
  const [echo, setEcho]      = useState(0.3);
  const [debit, setDebit]    = useState(0.4);

  // Enregistrement
  const [enr, setEnr] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const wavRecRef = useRef({ active: false, proc: null, buffersL: [], buffersR: [], length: 0 });

  // Helpers
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const msFromSpeed = (v) => Math.round(250 + v * (2500 - 250));
  const BASE_NOISE = 0.006;
  const burstMs  = () => Math.round(120 + debit * 520);
  const burstGain = () => Math.min(0.40, 0.08 + debit * 0.32);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const supportsType = (m) => window.MediaRecorder?.isTypeSupported?.(m) || false;

  /* ===== Charger stations (deux fichiers) ===== */
  useEffect(() => {
    (async () => {
      const all = [];
      try {
        const r = await fetch("/stations.json", { cache: "no-store" });
        if (r.ok) all.push(...normalizeStationsJson(await r.json()));
      } catch {}
      try {
        const r2 = await fetch("/stations-extra.json", { cache: "no-store" });
        if (r2.ok) all.push(...normalizeStationsJson(await r2.json()));
      } catch {}
      let flat = all.length ? all : FALLBACK_STATIONS;
      const seen = new Set();
      flat = flat.filter((s) => (s && s.url && !seen.has(s.url) ? (seen.add(s.url), true) : false));
      setStations(flat); stationsRef.current = flat;
      idxRef.current = 0; setIdx(0);
    })();
  }, []);

  function normalizeStationsJson(json) {
    let list = [];
    const push = (name, url, suffix = "") => {
      if (!url || typeof url !== "string") return;
      if (!/^https:/i.test(url)) return;
      if (!isDirectish(url)) return;
      try {
        url = url.trim();
        const nm = (name && name.trim()) || new URL(url).host + suffix;
        list.push({ name: nm, url });
      } catch {}
    };
    if (Array.isArray(json)) {
      json.forEach((s) => { if (!s) return;
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
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function isDirectish(u) {
    try {
      const L = u.toLowerCase();
      if (/\.(m3u8|m3u|pls|xspf)(\?|$)/.test(L)) return false;
      const bad = ["tunein.", "radio.garden", "streema", "radioline.", "deezer.", "spotify."];
      if (bad.some((d) => L.includes(d))) return false;
      return true;
    } catch { return false; }
  }
  function withCacheBust(url) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}ghostbox_live=${Date.now()}`;
  }

  /* ===== Init Audio ===== */
  async function initAudio() {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxRef.current = ctx;

    // Master (HP)
    const master = ctx.createGain(); master.gain.value = clamp01(volume); master.connect(ctx.destination);
    masterRef.current = master;

    // REC bus (master + mic)
    const recordMix = ctx.createGain(); recordMix.gain.value = 1; recordMixRef.current = recordMix;
    const dest = ctx.createMediaStreamDestination(); destRef.current = dest;
    recordMix.connect(dest);

    // Master va aussi vers REC
    master.connect(recordMix);

    // Radio gain (sera câblé par attachMedia)
    const gRadio = ctx.createGain(); gRadio.gain.value = 1; radioGainRef.current = gRadio;

    // Bruit
    const noise = createNoiseNode(ctx); noiseNodeRef.current = noise;
    const hpN = ctx.createBiquadFilter(); hpN.type = "highpass"; hpN.frequency.value = 160; hpN.Q.value = 0.7;
    const bp  = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.55; bp.frequency.value = 1800;
    const lpN = ctx.createBiquadFilter(); lpN.type = "lowpass";  lpN.frequency.value = 5200; lpN.Q.value = 0.3;
    noiseHPRef.current = hpN; noiseFilterRef.current = bp; noiseLPRef.current = lpN;
    const gNoise = ctx.createGain(); gNoise.gain.value = 0; noiseGainRef.current = gNoise;

    // Auto filtre radio
    const hp = ctx.createBiquadFilter();  hp.type = "highpass"; hp.frequency.value = 320; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();  lp.type = "lowpass";  lp.frequency.value = 3400; lp.Q.value = 0.7;
    const shelf = ctx.createBiquadFilter(); shelf.type = "highshelf"; shelf.frequency.value = 2500; shelf.gain.value = -4;
    const drive = createDriveNode(ctx, 0.22);
    radioHPRef.current = hp; radioLPRef.current = lp; radioShelfRef.current = shelf; driveRef.current = drive;

    // Dry & Écho
    const dry = ctx.createGain(); dry.gain.value = 1; dryRef.current = dry;
    const dly = ctx.createDelay(1.2); dly.delayTime.value = 0.34;
    const fb  = ctx.createGain(); fb.gain.value = 0.25;
    dly.connect(fb); fb.connect(dly);
    const wet = ctx.createGain(); wet.gain.value = 0;
    echoDelayRef.current = dly; echoFbRef.current = fb; echoWetRef.current = wet;

    // Clic
    const clickBus = ctx.createGain(); clickBus.gain.value = 0; clickBus.connect(master);
    clickBusRef.current = clickBus;

    // Somme → master
    const sum = ctx.createGain(); sum.gain.value = 1;
    // bruit : noise → HP → BP → LP → gNoise → sum
    noise.connect(hpN); hpN.connect(bp); bp.connect(lpN); lpN.connect(gNoise); gNoise.connect(sum);
    // radio (branchée via attachMedia → gRadio)
    gRadio.connect(sum);

    sum.connect(dry);  dry.connect(master);
    sum.connect(dly);  dly.connect(wet); wet.connect(master);

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

  /* ===== Attacher la radio au graphe (avec fallback captureStream) ===== */
  async function attachMedia() {
    if (!ctxRef.current || !audioElRef.current) return;
    if (mediaSrcRef.current) return;

    const ctx = ctxRef.current;
    const el = audioElRef.current;

    // 1) Tentative standard : MediaElementSource
    try {
      const src = ctx.createMediaElementSource(el);
      mediaSrcRef.current = src;

      if (AUTO_FILTER && radioHPRef.current) {
        src.connect(radioHPRef.current);
        radioHPRef.current.connect(radioLPRef.current);
        radioLPRef.current.connect(radioShelfRef.current);
        radioShelfRef.current.connect(driveRef.current);
        driveRef.current.connect(radioGainRef.current);
      } else {
        src.connect(radioGainRef.current);
      }

      setCompat(false);
      return;
    } catch (e) {
      // continue vers fallback
    }

    // 2) Fallback : captureStream() → MediaStreamSource
    try {
      const stream = el.captureStream?.();
      if (stream && stream.getAudioTracks().length > 0) {
        const src2 = ctx.createMediaStreamSource(stream);
        mediaSrcRef.current = src2;

        if (AUTO_FILTER && radioHPRef.current) {
          src2.connect(radioHPRef.current);
          radioHPRef.current.connect(radioLPRef.current);
          radioLPRef.current.connect(radioShelfRef.current);
          radioShelfRef.current.connect(driveRef.current);
          driveRef.current.connect(radioGainRef.current);
        } else {
          src2.connect(radioGainRef.current);
        }

        setCompat(false); // on a une vraie source dans le graphe
        return;
      }
    } catch (e) {}

    // 3) Impossible d’ancrer la radio : compat à true (lecture sans mixage au graphe)
    setCompat(true);
  }

  /* ===== Micro (dans REC uniquement) ===== */
  async function toggleMic(on) {
    setMicErr("");
    if (!on) {
      try { micSrcRef.current?.disconnect(); micGainRef.current?.disconnect(); } catch {}
      try { micStreamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
      micSrcRef.current = null; micGainRef.current = null; micStreamRef.current = null;
      setMicOn(false);
      return true;
    }
    try {
      await initAudio();
      const ctx = ctxRef.current;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 2, echoCancellation: true, noiseSuppression: true, autoGainControl: false }
      });
      micStreamRef.current = stream;
      const mic = ctx.createMediaStreamSource(stream);
      const micGain = ctx.createGain(); micGain.gain.value = 1.0;
      mic.connect(micGain);
      // IMPORTANT : micro vers bus REC seulement
      micGain.connect(recordMixRef.current);
      micSrcRef.current = mic; micGainRef.current = micGain;
      setMicOn(true);
      return true;
    } catch (e) {
      setMicErr(e?.message || "Accès micro refusé");
      setMicOn(false);
      return false;
    }
  }

  /* ===== Power / Lecture ===== */
  async function powerOn() {
    await initAudio();
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    try { noiseGainRef.current.gain.value = BASE_NOISE; } catch {}
    await playIndex(idxRef.current);
    setMarche(true);
  }

  async function powerOff() {
    stopSweep();
    const el = audioElRef.current;
    try { noiseGainRef.current.gain.value = 0; } catch {}
    if (el) { el.pause(); el.src = ""; el.load(); }
    if (enr) { try { stopRecording(); } catch {} setEnr(false); }
    try { await ctxRef.current?.suspend(); } catch {}
    setMarche(false); setAuto(false); setEtat("arrêté");
    playingLockRef.current = false;
  }

  function triggerClick(level = 0.28) {
    const ctx = ctxRef.current; if (!ctx || !clickBusRef.current) return;
    const dur = 0.012;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(dur * ctx.sampleRate)), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/d.length, 12);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = clickBusRef.current; const now = ctx.currentTime;
    try { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(level, now);
          g.gain.exponentialRampToValueAtTime(0.0001, now + dur); } catch {}
    src.connect(g); src.start();
  }

  function playScanBurst(targetGain, durSec) {
    const ctx = ctxRef.current; if (!ctx) return;
    const now = ctx.currentTime;
    const bp = noiseFilterRef.current, hp = noiseHPRef.current, lp = noiseLPRef.current;
    const g = noiseGainRef.current?.gain;

    const q   = 0.35 + debit * 0.45;
    const lpF = 4200 + debit * 1600;
    const hpF = 160  + debit * 180;
    try {
      bp.Q.setTargetAtTime(q, now, 0.05);
      lp.frequency.setTargetAtTime(lpF, now, 0.08);
      hp.frequency.setTargetAtTime(hpF, now, 0.08);
    } catch {}

    const fStart = 800  + Math.random()*800;
    const fMid   = 1300 + Math.random()*1500;
    const fEnd   = 1800 + Math.random()*1800;
    const steps  = Math.max(4, Math.floor(durSec * 10));
    for (let i = 0; i <= steps; i++) {
      const t = now + (durSec * i) / steps;
      const x = i / steps;
      const f = (x < 0.6)
        ? fStart + (fMid - fStart) * (x / 0.6)
        : fMid   + (fEnd - fMid)   * ((x - 0.6) / 0.4);
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
        const t = now + attack + (durSec - attack) * (i / wobbleN);
        const lvl = targetGain * (0.38 + 0.22*Math.random());
        g.linearRampToValueAtTime(lvl, t);
      }
    } catch {}
  }

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

    triggerClick();
    try {
      if (!compat) {
        radioGainRef.current.gain.cancelScheduledValues(now);
        radioGainRef.current.gain.linearRampToValueAtTime(0.0001, now + 0.05);
      } else { el.volume = 0; }
    } catch {}
    playScanBurst(targetNoise, dur);
    setEtat("balayage…");

    await sleep(Math.max(100, dur * 600));

    try {
      el.crossOrigin = "anonymous";
      el.pause();
      el.src = withCacheBust(url);
      el.load();

      const onStall = () => setEtat("buffering…");
      el.addEventListener("waiting", onStall, { once: true });
      el.addEventListener("stalled", onStall, { once: true });

      const playP = el.play();
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500));
      await Promise.race([playP, timeout]);

      await attachMedia(); // <— ANCRAGE au graphe (MediaElementSource OU captureStream)
      applyAutoFilterProfile();

      const after = ctx.currentTime + Math.max(0.08, dur * 0.6);
      try {
        noiseGainRef.current.gain.setTargetAtTime(BASE_NOISE, after, 0.12);
        if (!compat) radioGainRef.current.gain.setTargetAtTime(1, after, 0.08);
        else el.volume = clamp01(volume);
      } catch {}

      idxRef.current = startIndex; setIdx(startIndex);
      setEtat(compat ? "lecture (compatibilité)" : "lecture");
    } catch {
      try { noiseGainRef.current.gain.setTargetAtTime(BASE_NOISE, ctx.currentTime + 0.05, 0.12); } catch {}
      const next = (startIndex + 1) % list.length;
      playingLockRef.current = false;
      await playIndex(next, tries + 1);
      return;
    }

    playingLockRef.current = false;
  }

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
  function stopSweep() {
    if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current);
    sweepTimerRef.current = null;
  }

  /* ===== ENREGISTREMENT (MP3/WAV) ===== */
  async function startRecording() {
    await initAudio();

    // Auto-armer le micro si pas déjà ON (pour garantir mix Ghostbox+Mic)
    if (!micOn) { await toggleMic(true); }

    if (supportsType("audio/mpeg")) {
      const rec = new MediaRecorder(destRef.current.stream, { mimeType: "audio/mpeg" });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/mpeg" });
        downloadBlob(URL.createObjectURL(blob), "ghostbox-mix.mp3");
      };
      rec.start();
      recRef.current = rec;
      setEnr(true);
      return;
    }

    // Fallback WAV (ScriptProcessor)
    const ctx = ctxRef.current;
    const proc = ctx.createScriptProcessor(4096, 2, 2);
    wavRecRef.current = { active: true, proc, buffersL: [], buffersR: [], length: 0 };
    recordMixRef.current.connect(proc);
    proc.connect(ctx.destination);
    proc.onaudioprocess = (e) => {
      if (!wavRecRef.current.active) return;
      const inL = e.inputBuffer.getChannelData(0);
      const inR = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : inL;
      wavRecRef.current.buffersL.push(new Float32Array(inL));
      wavRecRef.current.buffersR.push(new Float32Array(inR));
      wavRecRef.current.length += inL.length;
    };
    setEnr(true);
  }

  function stopRecording() {
    // MP3
    if (recRef.current && recRef.current.state !== "inactive") {
      try { recRef.current.stop(); } catch {}
      recRef.current = null; setEnr(false); return;
    }
    // WAV
    if (!wavRecRef.current.active) return;
    wavRecRef.current.active = false;
    try { recordMixRef.current.disconnect(wavRecRef.current.proc); } catch {}
    try { wavRecRef.current.proc.disconnect(); } catch {}

    const { buffersL, buffersR, length } = wavRecRef.current;
    const ctx = ctxRef.current;
    const rate = ctx?.sampleRate || 48000;
    const L = new Float32Array(length);
    const R = new Float32Array(length);
    let off = 0;
    for (let i = 0; i < buffersL.length; i++) { L.set(buffersL[i], off); R.set(buffersR[i], off); off += buffersL[i].length; }
    const wav = encodeWAV(L, R, rate);
    const blob = new Blob([wav], { type: "audio/wav" });
    downloadBlob(URL.createObjectURL(blob), "ghostbox-mix.wav");
    setEnr(false);
  }

  function downloadBlob(url, filename) {
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function encodeWAV(left, right, sampleRate) {
    const numFrames = left.length;
    const buffer = new ArrayBuffer(44 + numFrames * 4);
    const view = new DataView(buffer);
    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + numFrames * 4, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, "data");
    view.setUint32(40, numFrames * 4, true);
    floatTo16BitPCM(view, 44, left, right);
    return view;
  }
  function writeString(view, offset, str) { for (let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i)); }
  function floatTo16BitPCM(view, offset, left, right) {
    let pos = offset;
    for (let i = 0; i < left.length; i++, pos += 4) {
      const l = Math.max(-1, Math.min(1, left[i])) * 0.95;
      const r = Math.max(-1, Math.min(1, right[i])) * 0.95;
      view.setInt16(pos,     l < 0 ? l * 0x8000 : l * 0x7FFF, true);
      view.setInt16(pos + 2, r < 0 ? r * 0x8000 : r * 0x7FFF, true);
    }
  }

  /* ===== Réactions contrôles ===== */
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

  function toggleEnr() { if (!enr) startRecording(); else stopRecording(); }

  /* ===== UI ===== */
  const list = stationsRef.current;
  const current = list[idxRef.current];
  const currentName = current?.name || (current?.url ? new URL(current.url).host : "");

  return (
    <main style={styles.page}>
      <div style={styles.shadowWrap}>
        <div style={styles.cabinet}>
          <div style={styles.textureOverlay} />

          <div style={styles.headerBar}>
            <div style={styles.brandPlate}>
              <div style={styles.brandText}>MADAME FANTÔMES</div>
              <div style={styles.brandSub}>Ghostbox • Formation TCI</div>
            </div>
            <div style={styles.rightHeader}>
              <div style={styles.lampsRow}>
                <Lamp label="MARCHE" on={marche} />
                <Lamp label="AUTO"   on={auto} colorOn="#86fb6a" />
                <Lamp label="ENR"    on={enr}  colorOn="#ff5656" />
                <Lamp label="MIC"    on={micOn} colorOn="#6ac8ff" />
              </div>
            </div>
          </div>

          <div style={styles.glass}>
            <div style={styles.stationRow}>
              <div><strong>{currentName || "—"}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && <div style={styles.compatBanner}>Compat : radio non câblée (CORS), mais captureStream tenté pour le REC.</div>}
            {micErr && <div style={styles.warnBanner}>Micro : {micErr}</div>}
          </div>

          <div style={styles.controlsRow}>
            <div style={styles.switches}>
              <Switch label="MARCHE" on={marche} onChange={async v => { setMarche(v); v ? await powerOn() : await powerOff(); }} />
              <Switch label="BALAYAGE AUTO" on={auto} onChange={(v) => setAuto(v)} />
              <Switch label="MICRO ENR" on={micOn} onChange={(v) => toggleMic(v)} />
              <Bouton label={enr ? (supportsType("audio/mpeg") ? "STOP ENREG. (MP3)" : "STOP ENREG. (WAV)") : "ENREGISTRER"} onClick={toggleEnr} color={enr ? "#f0c14b" : "#d96254"} />
            </div>

            <div style={styles.knobs}>
              <Knob label="VITESSE" value={vitesse} onChange={(v) => setVitesse(clamp01(v))} hint={`${msFromSpeed(vitesse)} ms`} />
              <Knob label="VOLUME"  value={volume}  onChange={(v) => setVolume(clamp01(v))} />
              <Knob label="ÉCHO"    value={echo}    onChange={(v) => setEcho(clamp01(v))} />
              <Knob label="DÉBIT"   value={debit}   onChange={(v) => setDebit(clamp01(v))} hint={`${burstMs()} ms de bruit`} />
            </div>
          </div>

          <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
        </div>

        <Vis at="tl" /><Vis at="tr" /><Vis at="bl" /><Vis at="br" />
      </div>

      <p style={{ color: "rgba(255,255,255,0.8)", marginTop: 10, fontSize: 12 }}>
        L’enregistrement mélange toujours Ghostbox + Micro dans un seul fichier (MP3 si possible, sinon WAV).
      </p>
    </main>
  );
}

/* ===== UI widgets & styles ===== */

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

const styles = {
  page: { minHeight: "100vh", background: "linear-gradient(180deg,#1b2432 0%,#0f1723 60%,#0a0f18 100%)", display: "grid", placeItems: "center", padding: 24 },
  shadowWrap: { position: "relative" },
  cabinet: {
    width: "min(980px, 94vw)", borderRadius: 26, padding: 16,
    border: "1px solid rgba(48,42,36,0.55)",
    boxShadow: "0 30px 88px rgba(0,0,0,0.65), inset 0 0 0 1px rgba(255,255,255,0.04)",
    backgroundImage: "url('/skin-watercolor.svg')", backgroundSize: "cover", backgroundPosition: "center", backgroundBlendMode: "multiply",
    position: "relative", overflow: "hidden"
  },
  textureOverlay: { position: "absolute", inset: 0, pointerEvents: "none",
    background: "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.06), rgba(255,255,255,0) 60%), radial-gradient(circle at 70% 70%, rgba(0,0,0,0.12), rgba(0,0,0,0) 55%)" },
  headerBar: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  brandPlate: { background: "linear-gradient(180deg,#2a2f36,#1c2129)", color: "#efe6d2", borderRadius: 12, border: "1px solid #2a2e36", padding: "10px 14px", boxShadow: "inset 0 0 20px rgba(0,0,0,0.45)" },
  brandText: { fontFamily: "Georgia,serif", fontWeight: 800, letterSpacing: 1.5, fontSize: 14 },
  brandSub: { fontFamily: "Georgia,serif", fontSize: 12, opacity: 0.8 },
  rightHeader: { display: "flex", alignItems: "center", gap: 12 },
  lampsRow: { display: "flex", gap: 14, alignItems: "center" },
  glass: { borderRadius: 16, border: "1px solid rgba(35,45,60,0.9)", background: "linear-gradient(180deg, rgba(168,201,210,0.55), rgba(58,88,110,0.6))", padding: 12, position: "relative", overflow: "hidden", boxShadow: "inset 0 0 32px rgba(0,0,0,0.55)" },
  stationRow: { display: "flex", justifyContent: "space-between", color: "#f3efe6", fontSize: 13, padding: "2px 2px" },
  compatBanner: { position: "absolute", right: 10, bottom: 10, background: "rgba(240,180,60,0.18)", border: "1px solid rgba(240,180,60,0.35)", color: "#f0c572", padding: "6px 10px", borderRadius: 8, fontSize: 12 },
  warnBanner: { position: "absolute", left: 10, bottom: 10, background: "rgba(255,80,80,0.18)", border: "1px solid rgba(255,80,80,0.35)", color: "#ff8c8c", padding: "6px 10px", borderRadius: 8, fontSize: 12 },
  controlsRow: { marginTop: 16, display: "grid", gridTemplateColumns: "1fr 2fr", gap: 14, alignItems: "center" },
  switches: { display: "grid", gap: 10, alignContent: "start" },
  knobs: { display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: 14, alignItems: "center", justifyItems: "center" }
};
const ui = {
  knobBlock: { display: "grid", justifyItems: "center" },
  knob: {
    width: 100, height: 100, borderRadius: "50%",
    background: "radial-gradient(circle at 32% 28%, #6d6f79, #3a3f4a 62%, #1b2230 100%)",
    border: "1px solid rgba(28,30,38,0.9)", boxShadow: "inset 0 12px 30px rgba(0,0,0,0.55), 0 8px 26px rgba(0,0,0,0.45)",
    display: "grid", placeItems: "center", touchAction: "none", userSelect: "none", cursor: "grab"
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
  lampLabel: { color: "#efe6d2", fontSize: 11, letterSpacing: 1, fontFamily: "Georgia,serif" }
};
const decor = {
  screw: { position: "absolute", width: 18, height: 18, borderRadius: "50%", background: "radial-gradient(circle at 30% 30%, #9aa0ad, #4b515e 60%, #1e232d)", border: "1px solid #222834", boxShadow: "0 8px 20px rgba(0,0,0,0.5), inset 0 3px 8px rgba(0,0,0,0.6)" }
};
