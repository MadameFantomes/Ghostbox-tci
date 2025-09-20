"use client";

/**
 * Ghostbox TCI — FR (balayage type “burst” + ducking, comme le code que tu as collé)
 * - Bruit de fond très discret (loin derrière), bursts doux lors du changement de station
 * - Ducking auto : quand la radio joue, le bruit retombe au plancher
 * - Balayage AUTO + skip flux HS (timeout) + anti-boucle (resync direct)
 * - Filtre radio simple auto (HP/LP), aucun “tube”/drive
 * - ENREGISTRER (MP3 si possible, sinon WAV)
 * - Charge /public/stations.json + /public/stations-extra.json sinon fallback
 */

import React, { useEffect, useRef, useState } from "react";

/* ===== Détection codecs ===== */
const probe = typeof Audio !== "undefined" ? new Audio() : null;
const SUPPORT_MP3 = !!probe?.canPlayType?.("audio/mpeg");
const SUPPORT_AAC = !!(
  probe?.canPlayType?.("audio/aac") ||
  probe?.canPlayType?.('audio/mp4; codecs="mp4a.40.2"')
);
function guessCodec(url = "") {
  const L = url.toLowerCase();
  if (L.includes(".mp3") || L.includes("/mp3") || L.includes("mp3_")) return "mp3";
  if (L.includes(".aac") || L.includes("/aac") || L.includes("aacp") || L.includes("aac_")) return "aac";
  return "unknown";
}

/* ===== Réglages & Fallback ===== */
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

/* ===== Utils ===== */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const shuffleInPlace = (a) => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
const dedupByUrl = (arr) => { const seen=new Set(); return arr.filter(s => (s && s.url && !seen.has(s.url) ? (seen.add(s.url), true) : false)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function Page() {
  const audioElRef = useRef(null);

  // Audio graph
  const ctxRef = useRef(null);
  const masterRef = useRef(null);
  const destRef = useRef(null);

  // Source radio + EQ
  const mediaSrcRef = useRef(null);
  const radioGainRef = useRef(null);
  const radioHPRef = useRef(null);
  const radioLPRef = useRef(null);

  // Bruit de balayage
  const noiseNodeRef = useRef(null);
  const noiseHPRef = useRef(null);
  const noiseBPRef = useRef(null);
  const noiseLPRef = useRef(null);
  const noiseGainRef = useRef(null);

  // Mix & Écho
  const dryRef = useRef(null);
  const echoDelayRef = useRef(null);
  const echoFbRef = useRef(null);
  const echoWetRef = useRef(null);

  // “clic” discret
  const clickBusRef = useRef(null);

  // Watchdog anti-boucle
  const progressRef = useRef({ lastCT: 0, lastWall: 0, timer: null });
  const nowMs = () => performance.now();

  // Stations
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
  const playingLockRef = useRef(false);

  // Contrôles
  const [vitesse, setVitesse] = useState(0.45); // 250..2500 ms
  const [volume, setVolume]   = useState(0.9);
  const [echo, setEcho]       = useState(0.30);
  const [bruit, setBruit]     = useState(0.40); // (= ex “débit”) → plus doux par défaut

  // Enregistrement
  const [enr, setEnr] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const wavRecRef = useRef({ active: false, proc: null, tap: null, buffersL: [], buffersR: [], length: 0 });

  // Params bruit/balayage (comme ton code)
  const BASE_NOISE = 0.006; // lit très faible
  const msFromSpeed = (v) => Math.round(250 + v * (2500 - 250)); // 250..2500ms
  const burstMs  = () => Math.round(120 + bruit * 520);          // 120..640ms
  const burstGain = () => Math.min(0.40, 0.08 + bruit * 0.32);   // plafonné ~0.40

  const supportsType = (m) => window.MediaRecorder?.isTypeSupported?.(m) || false;

  /* ===== Charger stations.json + stations-extra.json ===== */
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
      // Filtrer par codec jouable
      flat = flat.filter((s) => {
        const c = guessCodec(s.url);
        if (c === "mp3") return SUPPORT_MP3;
        if (c === "aac") return SUPPORT_AAC;
        return true;
      });
      if (!flat.length) flat = FALLBACK_STATIONS;
      stationsRef.current = flat;
      setStations(flat);
      idxRef.current = 0; setIdx(0);
      setEtat("prêt");
    })();
  }, []);

  function normalizeStationsJson(json) {
    let list = [];
    const push = (name, url, suffix="") => {
      if (!url || typeof url !== "string") return;
      if (!/^https:/i.test(url)) return;
      const L = url.toLowerCase();
      if (/\.(m3u8|m3u|pls|xspf)(\?|$)/.test(L)) return; // éviter playlists
      try { url = url.trim(); list.push({ name: (name && name.trim()) || new URL(url).host + suffix, url }); } catch {}
    };
    if (Array.isArray(json)) {
      json.forEach(s => { if (!s) return; if (s.url) push(s.name, s.url); if (Array.isArray(s.urls)) s.urls.forEach((u,k)=>push(s.name,u,` #${k+1}`)); });
    } else if (json && typeof json === "object") {
      Object.entries(json).forEach(([group, arr]) => Array.isArray(arr) && arr.forEach(s => {
        if (!s) return; if (s.url) push(s.name||group, s.url); if (Array.isArray(s.urls)) s.urls.forEach((u,k)=>push(s.name||group,u,` #${k+1}`));
      }));
    }
    const seen = new Set();
    list = list.filter(s => (seen.has(s.url) ? false : seen.add(s.url)));
    return shuffleInPlace(list);
  }

  /* ===== WebAudio init ===== */
  async function initAudio() {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxRef.current = ctx;

    // Master
    const master = ctx.createGain(); master.gain.value = clamp01(volume); master.connect(ctx.destination);
    masterRef.current = master;

    // Destination enregistrement
    const dest = ctx.createMediaStreamDestination(); master.connect(dest);
    destRef.current = dest;

    // Radio path (HP→LP→gain) — pas de “tube”
    const hp = ctx.createBiquadFilter();  hp.type = "highpass"; hp.frequency.value = 320; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();  lp.type = "lowpass";  lp.frequency.value = 3400; lp.Q.value = 0.7;
    const gRadio = ctx.createGain(); gRadio.gain.value = 1;
    radioHPRef.current = hp; radioLPRef.current = lp; radioGainRef.current = gRadio;

    // Bruit (HP→BP→LP→gNoise)
    const noise = createNoiseNode(ctx); noiseNodeRef.current = noise;
    const hpN = ctx.createBiquadFilter(); hpN.type = "highpass"; hpN.frequency.value = 160; hpN.Q.value = 0.7;
    const bp  = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.55; bp.frequency.value = 1800;
    const lpN = ctx.createBiquadFilter(); lpN.type = "lowpass";  lpN.frequency.value = 5200; lpN.Q.value = 0.3;
    noiseHPRef.current = hpN; noiseBPRef.current = bp; noiseLPRef.current = lpN;
    const gNoise = ctx.createGain(); gNoise.gain.value = 0; noiseGainRef.current = gNoise;

    // Mix sec + ÉCHO
    const dry = ctx.createGain(); dry.gain.value = 1; dryRef.current = dry;
    const dly = ctx.createDelay(1.2); dly.delayTime.value = 0.34;
    const fb  = ctx.createGain(); fb.gain.value = 0.25;
    dly.connect(fb); fb.connect(dly);
    const wet = ctx.createGain(); wet.gain.value = 0;
    echoDelayRef.current = dly; echoFbRef.current = fb; echoWetRef.current = wet;

    // Clic
    const clickBus = ctx.createGain(); clickBus.gain.value = 0; clickBus.connect(master); clickBusRef.current = clickBus;

    // Somme → master
    const sum = ctx.createGain(); sum.gain.value = 1;
    // bruit : noise → HP → BP → LP → gNoise → sum
    noise.connect(hpN); hpN.connect(bp); bp.connect(lpN); lpN.connect(gNoise); gNoise.connect(sum);
    // radio: src → HP → LP → gRadio → sum (branchée dans attachMedia)
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
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; return src;
  }

  function applyAutoFilterProfile() {
    const ctx = ctxRef.current; if (!AUTO_FILTER || !ctx || !radioHPRef.current) return;
    const now = ctx.currentTime;
    const hpF = 260 + Math.random() * 160;   // 260..420 Hz
    const lpF = 2800 + Math.random() * 1400; // 2.8..4.2 kHz
    try {
      radioHPRef.current.frequency.setTargetAtTime(hpF, now, 0.08);
      radioLPRef.current.frequency.setTargetAtTime(lpF, now, 0.08);
    } catch {}
  }

  async function attachMedia() {
    if (!ctxRef.current || !audioElRef.current) return;
    if (mediaSrcRef.current) return;
    try {
      const src = ctxRef.current.createMediaElementSource(audioElRef.current);
      mediaSrcRef.current = src;
      // src → HP → LP → gRadio
      src.connect(radioHPRef.current);
      radioHPRef.current.connect(radioLPRef.current);
      radioLPRef.current.connect(radioGainRef.current);

      // Ducking du bruit quand la radio parle
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

      setCompat(false);
    } catch {
      setCompat(true); // CORS : lecture via <audio> sans traitement
    }
  }

  /* ===== Power ===== */
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
    stopWatchdog();
    const el = audioElRef.current;
    try { noiseGainRef.current.gain.value = 0; } catch {}
    if (el) { el.pause(); el.src = ""; el.load(); }
    if (enr) { try { stopRecording(); } catch {} setEnr(false); }
    try { await ctxRef.current?.suspend(); } catch {}
    setMarche(false); setAuto(false); setEtat("arrêté");
    playingLockRef.current = false;
  }

  /* ===== “clic” ===== */
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

  /* ===== Burst de balayage (reprend ton code) ===== */
  function playScanBurst(targetGain, durSec) {
    const ctx = ctxRef.current; if (!ctx) return;
    const now = ctx.currentTime;

    const bp = noiseBPRef.current, hp = noiseHPRef.current, lp = noiseLPRef.current;
    const g = noiseGainRef.current?.gain;

    // Couleur selon BRUIT (ex-”débit”), adoucie
    const q   = 0.35 + bruit * 0.45;    // 0.35..0.80
    const lpF = 4200 + bruit * 1600;    // 4.2..5.8 kHz
    const hpF = 160  + bruit * 180;     // 160..340 Hz
    try {
      bp.Q.setTargetAtTime(q, now, 0.05);
      lp.frequency.setTargetAtTime(lpF, now, 0.08);
      hp.frequency.setTargetAtTime(hpF, now, 0.08);
    } catch {}

    // Glissando + jitter doux
    const fStart = 800  + Math.random()*800;   // 0.8–1.6 kHz
    const fMid   = 1300 + Math.random()*1500;  // 1.3–2.8 kHz
    const fEnd   = 1800 + Math.random()*1800;  // 1.8–3.6 kHz
    const steps  = Math.max(4, Math.floor(durSec * 10));
    for (let i = 0; i <= steps; i++) {
      const t = now + (durSec * i) / steps;
      const x = i / steps;
      const f = (x < 0.6)
        ? fStart + (fMid - fStart) * (x / 0.6)
        : fMid   + (fEnd - fMid)   * ((x - 0.6) / 0.4);
      const jitter = (Math.random()*2 - 1) * (80 + 380*(1 - bruit));
      try { bp.frequency.linearRampToValueAtTime(Math.max(300, f + jitter), t); } catch {}
    }

    // Enveloppe modeste + petites vagues
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

  /* ===== Lecture robuste + anti-boucle ===== */
  function withCacheBust(url) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}ghostbox_live=${Date.now()}`;
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

    // clic + montée du bruit, radio vers 0
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
      stopWatchdog();
      el.crossOrigin = "anonymous";
      el.preload = "none";
      el.pause();

      // type MIME (aide certains navigateurs)
      el.removeAttribute("type");
      const codec = guessCodec(url);
      if (codec === "mp3") el.type = "audio/mpeg";
      else if (codec === "aac") el.type = "audio/aac";

      el.src = withCacheBust(url);
      el.load();

      const onStall = () => setEtat("buffering…");
      el.addEventListener("waiting", onStall, { once: true });
      el.addEventListener("stalled", onStall, { once: true });

      const playP = el.play();
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500));
      await Promise.race([playP, timeout]);

      await attachMedia();
      applyAutoFilterProfile();
      startWatchdog();

      // retour : bruit → plancher, radio → 1
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

  function startWatchdog() {
    stopWatchdog();
    const el = audioElRef.current; if (!el) return;
    progressRef.current.lastCT = 0;
    progressRef.current.lastWall = nowMs();

    const tick = () => {
      const now = nowMs();
      const ct = el.currentTime || 0;

      if (ct <= progressRef.current.lastCT + 0.05) {
        if (now - progressRef.current.lastWall > 2500) { resyncSameStation(); return; }
      } else {
        progressRef.current.lastCT = ct;
        progressRef.current.lastWall = now;
      }

      if (ct + 0.25 < progressRef.current.lastCT) { resyncSameStation(); return; }

      progressRef.current.timer = setTimeout(tick, 500);
    };
    progressRef.current.timer = setTimeout(tick, 800);
  }
  function stopWatchdog() {
    if (progressRef.current.timer) clearTimeout(progressRef.current.timer);
    progressRef.current.timer = null;
  }
  async function resyncSameStation() {
    stopWatchdog();
    const el = audioElRef.current; if (!el) return;
    try {
      setEtat("resync direct…");
      const cur = stationsRef.current[idxRef.current];
      const url = typeof cur === "string" ? cur : cur.url;
      el.pause(); el.src = ""; el.load();
      await sleep(80);
      el.src = withCacheBust(url); el.load();
      await el.play();
      startWatchdog();
      setEtat("lecture");
    } catch {}
  }

  /* ===== Balayage auto ===== */
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

  /* ===== Enregistrement MP3/WAV ===== */
  function startRecording() {
    if (!destRef.current) return;
    if (supportsType("audio/mpeg")) {
      const rec = new MediaRecorder(destRef.current.stream, { mimeType: "audio/mpeg" });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/mpeg" });
        downloadBlob(URL.createObjectURL(blob), "ghostbox.mp3");
      };
      rec.start(); recRef.current = rec; setEnr(true); return;
    }
    // WAV fallback
    const ctx = ctxRef.current;
    const proc = ctx.createScriptProcessor(4096, 2, 2);
    const tap = ctx.createGain(); tap.gain.value = 1;
    masterRef.current.connect(tap);
    tap.connect(proc); proc.connect(ctx.destination);
    wavRecRef.current = { active: true, proc, tap, buffersL: [], buffersR: [], length: 0 };
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
    if (recRef.current && recRef.current.state !== "inactive") {
      try { recRef.current.stop(); } catch {}
      recRef.current = null; setEnr(false); return;
    }
    if (!wavRecRef.current.active) return;
    wavRecRef.current.active = false;
    try { masterRef.current.disconnect(wavRecRef.current.tap); } catch {}
    try { wavRecRef.current.proc.disconnect(); } catch {}

    const { buffersL, buffersR, length } = wavRecRef.current;
    const ctx = ctxRef.current; const rate = ctx?.sampleRate || 48000;
    const L = new Float32Array(length); const R = new Float32Array(length);
    let off = 0;
    for (let i = 0; i < buffersL.length; i++) { L.set(buffersL[i], off); R.set(buffersR[i], off); off += buffersL[i].length; }
    const wav = encodeWAV(L, R, rate);
    const blob = new Blob([wav], { type: "audio/wav" });
    downloadBlob(URL.createObjectURL(blob), "ghostbox.wav");
    setEnr(false);
  }
  function toggleEnr() { if (!enr) startRecording(); else stopRecording(); }
  function downloadBlob(url, filename) { const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0); }
  function encodeWAV(left, right, sampleRate) {
    const numFrames = left.length; const buffer = new ArrayBuffer(44 + numFrames * 4); const view = new DataView(buffer);
    writeString(view, 0, "RIFF"); view.setUint32(4, 36 + numFrames * 4, true);
    writeString(view, 8, "WAVE"); writeString(view, 12, "fmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
    writeString(view, 36, "data"); view.setUint32(40, numFrames * 4, true); floatTo16BitPCM(view, 44, left, right); return view;
  }
  function writeString(view, offset, str) { for (let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i)); }
  function floatTo16BitPCM(view, offset, left, right) {
    let pos = offset; for (let i = 0; i < left.length; i++, pos += 4) {
      const l = Math.max(-1, Math.min(1, left[i])) * 0.95; const r = Math.max(-1, Math.min(1, right[i])) * 0.95;
      view.setInt16(pos,     l < 0 ? l * 0x8000 : l * 0x7FFF, true);
      view.setInt16(pos + 2, r < 0 ? r * 0x8000 : r * 0x7FFF, true);
    }
  }

  /* ===== Effets des contrôles ===== */
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

  /* ===== UI ===== */
  const list = stationsRef.current;
  const current = list[idxRef.current];
  const currentName = current?.name || (current?.url ? new URL(current.url).host : "");

  return (
    <main style={styles.page}>
      <div style={styles.shadowWrap}>
        <div style={styles.cabinet}>
          <div style={styles.textureOverlay} />

          {/* En-tête (pas de compteur) */}
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
              </div>
            </div>
          </div>

          {/* Cadran / état */}
          <div style={styles.glass}>
            <div style={styles.stationRow}>
              <div><strong>{currentName || "—"}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && <div style={styles.compatBanner}>Compat CORS : traitement radio limité</div>}
          </div>

          {/* Contrôles */}
          <div style={styles.controlsRow}>
            <div style={styles.switches}>
              <Switch label="MARCHE" on={marche} onChange={async v => { setMarche(v); v ? await powerOn() : await powerOff(); }} />
              <Switch label="BALAYAGE AUTO" on={auto} onChange={(v) => setAuto(v)} />
              <Bouton label={enr ? "STOP ENREG." : "ENREGISTRER"} onClick={toggleEnr} color={enr ? "#f0c14b" : "#d96254"} />
            </div>

            <div style={styles.knobs}>
              <Knob label="VITESSE" value={vitesse} onChange={(v) => setVitesse(clamp01(v))} hint={`${msFromSpeed(vitesse)} ms`} />
              <Knob label="VOLUME"  value={volume}  onChange={(v) => setVolume(clamp01(v))} />
              <Knob label="ÉCHO"    value={echo}    onChange={(v) => setEcho(clamp01(v))} />
              <Knob label="BRUIT"   value={bruit}   onChange={(v) => setBruit(clamp01(v))} hint={`${burstMs()} ms de bruit`} />
            </div>
          </div>

          <audio ref={audioElRef} crossOrigin="anonymous" preload="none" style={{ display: "none" }} />
        </div>

        <Vis at="tl" /><Vis at="tr" /><Vis at="bl" /><Vis at="br" />
      </div>

      <p style={{ color: "rgba(255,255,255,0.8)", marginTop: 10, fontSize: 12 }}>
        Bruit très discret + burst adouci, exactement comme la version que tu aimais. Ajuste <strong>BRUIT</strong> (0.25–0.45) et <strong>VITESSE</strong>.
      </p>
    </main>
  );
}

/* ===== UI widgets ===== */

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

/* ===== Styles ===== */

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
const decor = { screw: { position: "absolute", width: 18, height: 18, borderRadius: "50%", background: "radial-gradient(circle at 30% 30%, #9aa0ad, #4b515e 60%, #1e232d)", border: "1px solid #222834", boxShadow: "0 8px 20px rgba(0,0,0,0.5), inset 0 3px 8px rgba(0,0,0,0.6)" } };
