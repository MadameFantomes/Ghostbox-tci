"use client";

/**
 * Ghostbox TCI — FR (balayage pur, sans “tube”, sans garde-voix)
 * - HP/LP simples (pas de convolver ni saturation)
 * - Balayage continu (VITESSE)
 * - Bruit blanc modulé “lit de bruit” en fond + impulsions de scan
 * - LIVE+ (Radios parlées MP3/HTTPS) + Anti-boucle + Enregistrement MP3/WAV
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

/* ===== Réglages & Fallbacks ===== */
const AUTO_FILTER = true;

const FALLBACK_STATIONS = [
  "https://icecast.radiofrance.fr/fip-midfi.mp3",
  "https://icecast.radiofrance.fr/franceinfo-midfi.mp3",
  "https://tsfjazz.ice.infomaniak.ch/tsfjazz-high.mp3"
].map((url) => ({ name: new URL(url).host, url }));

const CURATED_TALK_MP3 = [
  { name: "franceinfo", url: "https://icecast.radiofrance.fr/franceinfo-midfi.mp3", type: "news", lang: "fr", weight: 3 },
  { name: "France Inter", url: "https://icecast.radiofrance.fr/franceinter-midfi.mp3", type: "talk", lang: "fr", weight: 2 },
  { name: "France Culture", url: "https://icecast.radiofrance.fr/franceculture-midfi.mp3", type: "talk", lang: "fr", weight: 2 },
  { name: "RTL", url: "https://icecast.rtl.fr/rtl-1-44-128", type: "news", lang: "fr", weight: 2 },
  { name: "RMC", url: "https://audio.bfmtv.com/rmcradio_128.mp3", type: "news", lang: "fr", weight: 2 },
  { name: "RFI Monde", url: "https://rfimonde64k.ice.infomaniak.ch/rfimonde-64.mp3", type: "news", lang: "fr", weight: 2 },
  { name: "BBC World Service", url: "https://stream.live.vc.bbcmedia.co.uk/bbc_world_service", type: "news", lang: "en", weight: 2 },
  { name: "NPR News", url: "https://npr-ice.streamguys1.com/live.mp3", type: "news", lang: "en", weight: 2 },
  { name: "WNYC FM", url: "https://stream.wnyc.org/wnycfm", type: "talk", lang: "en", weight: 2 }
];

/* ===== Utils ===== */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const shuffleInPlace = (a) => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
const dedupByUrl = (arr) => { const seen=new Set(); return arr.filter(s => (s && s.url && !seen.has(s.url) ? (seen.add(s.url), true) : false)); };

/* ===== Composant principal ===== */
export default function Page() {
  const audioElRef = useRef(null);

  // Audio graph
  const ctxRef = useRef(null);
  const masterRef = useRef(null);
  const destRef = useRef(null);

  // Radio path
  const mediaSrcRef = useRef(null);
  const radioHPRef = useRef(null);
  const radioLPRef = useRef(null);
  const radioGainRef = useRef(null);

  // Mix sum
  const sumRef = useRef(null);

  // Bruit
  const noiseNodeRef = useRef(null);
  const noiseHPRef = useRef(null);
  const noiseBPRef = useRef(null);
  const noiseLPRef = useRef(null);
  const noiseGainRef = useRef(null);
  const noiseBedTimerRef = useRef(null);
  const inBurstRef = useRef(false);

  // Echo
  const dryRef = useRef(null);
  const echoDelayRef = useRef(null);
  const echoFbRef = useRef(null);
  const echoWetRef = useRef(null);

  // Click
  const clickBusRef = useRef(null);

  // Watchdog
  const progressRef = useRef({ lastCT: 0, lastWall: 0, timer: null });
  const nowMs = () => performance.now();

  // Stations
  const [stations, setStations] = useState(FALLBACK_STATIONS); // lisibles (affichage)
  const scanRef = useRef(FALLBACK_STATIONS);                   // liste pondérée pour le balayage
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
  const [echo, setEcho]       = useState(0.18);
  const [bruit, setBruit]     = useState(0.28); // plus doux par défaut

  // Enregistrement
  const [enr, setEnr] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const wavRecRef = useRef({ active: false, proc: null, tap: null, buffersL: [], buffersR: [], length: 0 });

  // LIVE+
  const [livePlus, setLivePlus] = useState(false);
  const augmentingRef = useRef(false);

  // Bruit helpers
  const BASE_NOISE = 0.0045; // lit de bruit bas
  const msFromSpeed = (v) => Math.round(250 + v * (2500 - 250));
  const burstMs  = () => Math.round(120 + bruit * 520);
  const burstGain = () => Math.min(0.32, 0.06 + bruit * 0.26); // burst plus discret qu'avant
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const supportsType = (m) => window.MediaRecorder?.isTypeSupported?.(m) || false;

  /* ===== Charger stations + filtrage + pondération ===== */
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

      flat = dedupByUrl(flat);
      let playable = flat.filter((s) => {
        const c = guessCodec(s.url);
        if (c === "mp3") return SUPPORT_MP3;
        if (c === "aac") return SUPPORT_AAC;
        return true;
      });
      if (playable.length < 6) playable = dedupByUrl([...playable, ...CURATED_TALK_MP3]);

      const weighted = buildWeighted(playable);
      if (!weighted.length) {
        playable = CURATED_TALK_MP3.slice();
        shuffleInPlace(playable);
        weighted.push(...playable);
      }

      setStations(playable);
      scanRef.current = weighted;
      idxRef.current = 0; setIdx(0);
      setEtat("prêt");
    })();
  }, []);

  function normalizeStationsJson(json) {
    const out = [];
    const push = (name, url, suffix = "", extra = {}) => {
      if (!url || typeof url !== "string") return;
      if (!/^https:/i.test(url)) return;
      if (!isDirectish(url)) return;
      try {
        url = url.trim();
        const nm = (name && name.trim()) || new URL(url).host + suffix;
        out.push({ name: nm, url, ...extra });
      } catch {}
    };
    if (Array.isArray(json)) {
      json.forEach((s) => {
        if (!s) return;
        if (s.url) push(s.name, s.url, "", { type: s.type, lang: s.lang, weight: s.weight });
        if (Array.isArray(s.urls)) s.urls.forEach((u, k) => push(s.name, u, ` #${k + 1}`, { type: s.type, lang: s.lang, weight: s.weight }));
      });
    } else if (json && typeof json === "object") {
      Object.entries(json).forEach(([group, arr]) => {
        if (!Array.isArray(arr)) return;
        arr.forEach((s) => {
          if (!s) return;
          if (s.url) push(s.name || group, s.url, "", { type: s.type, lang: s.lang, weight: s.weight });
          if (Array.isArray(s.urls)) s.urls.forEach((u, k) => push(s.name || group, u, ` #${k + 1}`, { type: s.type, lang: s.lang, weight: s.weight }));
        });
      });
    }
    return shuffleInPlace(out);
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
  function buildWeighted(playable) {
    const TALK = new Set(["talk", "news"]);
    const weighted = [];
    for (const s of playable) {
      const base = TALK.has((s.type || "").toLowerCase()) ? 2 : 1;
      const w = Math.max(1, Math.min(6, Math.round(s.weight || base)));
      for (let i = 0; i < w; i++) weighted.push(s);
    }
    return shuffleInPlace(weighted);
  }
  function withCacheBust(url) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}ghostbox_live=${Date.now()}`;
  }

  /* ===== Init Audio graph ===== */
  async function initAudio() {
    if (ctxRef.current) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxRef.current = ctx;

    // Master
    const master = ctx.createGain(); master.gain.value = clamp01(volume); master.connect(ctx.destination);
    masterRef.current = master;

    // Destination REC
    const dest = ctx.createMediaStreamDestination(); destRef.current = dest;
    master.connect(dest);

    // Radio path (EQ simple sans “tube”)
    const hp = ctx.createBiquadFilter();  hp.type = "highpass"; hp.frequency.value = 240; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();  lp.type = "lowpass";  lp.frequency.value = 5800; lp.Q.value = 0.7;
    const gRadio = ctx.createGain(); gRadio.gain.value = 1;
    radioHPRef.current = hp; radioLPRef.current = lp; radioGainRef.current = gRadio;

    // Bruit (lit + scanneur)
    const noise = createNoiseNode(ctx); noiseNodeRef.current = noise;
    const hpN = ctx.createBiquadFilter(); hpN.type = "highpass"; hpN.frequency.value = 140; hpN.Q.value = 0.7;
    const bp  = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.55; bp.frequency.value = 1600;
    const lpN = ctx.createBiquadFilter(); lpN.type = "lowpass";  lpN.frequency.value = 5200; lpN.Q.value = 0.3;
    noiseHPRef.current = hpN; noiseBPRef.current = bp; noiseLPRef.current = lpN;
    const gNoise = ctx.createGain(); gNoise.gain.value = 0; noiseGainRef.current = gNoise;

    // Echo
    const dry = ctx.createGain(); dry.gain.value = 1; dryRef.current = dry;
    const dly = ctx.createDelay(1.2); dly.delayTime.value = 0.28;
    const fb  = ctx.createGain(); fb.gain.value = 0.18;
    dly.connect(fb); fb.connect(dly);
    const wet = ctx.createGain(); wet.gain.value = 0; echoDelayRef.current = dly; echoFbRef.current = fb; echoWetRef.current = wet;

    // Click
    const clickBus = ctx.createGain(); clickBus.gain.value = 0; clickBus.connect(master); clickBusRef.current = clickBus;

    // Somme → master
    const sum = ctx.createGain(); sum.gain.value = 1; sumRef.current = sum;

    // câblage
    noise.connect(hpN); hpN.connect(bp); bp.connect(lpN); lpN.connect(gNoise); gNoise.connect(sum);
    // radio: src → HP → LP → gRadio → sum
    // (chaîné dynamiquement dans attachMedia)
    gRadio.connect(sum);

    // Sorties & effets
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
    const hpF = 200 + Math.random() * 180;   // plus neutre
    const lpF = 5200 + Math.random() * 1800; // plus ouvert
    try {
      radioHPRef.current.frequency.setTargetAtTime(hpF, now, 0.08);
      radioLPRef.current.frequency.setTargetAtTime(lpF, now, 0.08);
    } catch {}
  }

  /* ===== Attacher la radio ===== */
  async function attachMedia() {
    if (!ctxRef.current || !audioElRef.current) return;
    if (mediaSrcRef.current) return;
    const ctx = ctxRef.current;
    const el = audioElRef.current;

    const chainConnect = (srcNode) => {
      srcNode.connect(radioHPRef.current);
      radioHPRef.current.connect(radioLPRef.current);
      radioLPRef.current.connect(radioGainRef.current);
    };

    try {
      const src = ctx.createMediaElementSource(el);
      mediaSrcRef.current = src;
      chainConnect(src);
      setCompat(false);
      return;
    } catch {}

    try {
      const stream = el.captureStream?.();
      if (stream && stream.getAudioTracks().length > 0) {
        const src2 = ctx.createMediaStreamSource(stream);
        mediaSrcRef.current = src2;
        chainConnect(src2);
        setCompat(false);
        return;
      }
    } catch {}

    setCompat(true); // on entendra via <audio>, mais sans analyse (qu’on n’utilise plus)
  }

  /* ===== Lit de bruit modulé (fond) ===== */
  function startNoiseBed() {
    stopNoiseBed();
    const loop = () => {
      if (!noiseGainRef.current || !ctxRef.current) return;
      if (!marche) return;
      if (inBurstRef.current) { noiseBedTimerRef.current = setTimeout(loop, 160); return; }
      const ctx = ctxRef.current;
      const now = ctx.currentTime;
      const base = BASE_NOISE;
      const depth = 0.002 + bruit * 0.010; // +/- variation
      const target = Math.max(0, base + (Math.random() * 2 - 1) * depth);
      try {
        const g = noiseGainRef.current.gain;
        g.cancelScheduledValues(now);
        g.setTargetAtTime(target, now, 0.22); // glisse douce
      } catch {}
      noiseBedTimerRef.current = setTimeout(loop, 240 + Math.random() * 420);
    };
    loop();
  }
  function stopNoiseBed() {
    if (noiseBedTimerRef.current) clearTimeout(noiseBedTimerRef.current);
    noiseBedTimerRef.current = null;
  }

  /* ===== Power ===== */
  async function powerOn() {
    await initAudio();
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    try { noiseGainRef.current.gain.value = BASE_NOISE; } catch {}
    startNoiseBed();
    await playIndex(idxRef.current);
    setMarche(true);
  }
  async function powerOff() {
    stopSweep();
    stopWatchdog();
    stopNoiseBed();
    const el = audioElRef.current;
    try { noiseGainRef.current.gain.value = 0; } catch {}
    if (el) { el.pause(); el.src = ""; el.load(); }
    if (enr) { try { stopRecording(); } catch {} setEnr(false); }
    try { await ctxRef.current?.suspend(); } catch {}
    setMarche(false); setAuto(false); setEtat("arrêté");
    playingLockRef.current = false;
  }

  /* ===== Clic + Impulsions de scan ===== */
  function triggerClick(level = 0.24) {
    const ctx = ctxRef.current; if (!ctx || !clickBusRef.current) return;
    const dur = 0.011;
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
    const bp = noiseBPRef.current, hp = noiseHPRef.current, lp = noiseLPRef.current;
    const g = noiseGainRef.current?.gain;

    inBurstRef.current = true;

    const q   = 0.35 + bruit * 0.45;
    const lpF = 4200 + bruit * 1600;
    const hpF = 140  + bruit * 180;
    try {
      bp.Q.setTargetAtTime(q, now, 0.05);
      lp.frequency.setTargetAtTime(lpF, now, 0.08);
      hp.frequency.setTargetAtTime(hpF, now, 0.08);
    } catch {}

    const fStart = 700  + Math.random()*700;
    const fMid   = 1200 + Math.random()*1200;
    const fEnd   = 1800 + Math.random()*1400;
    const steps  = Math.max(4, Math.floor(durSec * 10));
    for (let i = 0; i <= steps; i++) {
      const t = now + (durSec * i) / steps;
      const x = i / steps;
      const f = (x < 0.6) ? fStart + (fMid - fStart) * (x / 0.6)
                          : fMid   + (fEnd - fMid)   * ((x - 0.6) / 0.4);
      const jitter = (Math.random()*2 - 1) * (80 + 280*(1 - bruit));
      try { bp.frequency.linearRampToValueAtTime(Math.max(300, f + jitter), t); } catch {}
    }

    try {
      g.cancelScheduledValues(now);
      const attack = Math.min(0.04, durSec * 0.22);
      g.setValueAtTime(BASE_NOISE, now);
      g.linearRampToValueAtTime(targetGain * (0.38 + 0.14*Math.random()), now + attack);
      g.linearRampToValueAtTime(BASE_NOISE, now + durSec + 0.04);
    } catch {}

    // fin de burst → on rend la main au lit de bruit
    setTimeout(() => { inBurstRef.current = false; }, Math.max(80, durSec * 1000 + 60));
  }

  /* ===== Lecture d'une station ===== */
  async function playIndex(startIndex, tries = 0) {
    const list = scanRef.current;
    if (!list.length) { setEtat("aucune station jouable"); return; }
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
      radioGainRef.current.gain.cancelScheduledValues(now);
      radioGainRef.current.gain.linearRampToValueAtTime(0.0001, now + 0.04);
    } catch {}
    playScanBurst(targetNoise, dur);
    setEtat("balayage…");

    await sleep(Math.max(100, dur * 600));

    try {
      stopWatchdog();
      el.crossOrigin = "anonymous";
      el.preload = "none";
      el.pause();

      const codec = guessCodec(url);
      el.removeAttribute("type");
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

      const after = ctx.currentTime + Math.max(0.06, dur * 0.5);
      try {
        radioGainRef.current.gain.setTargetAtTime(1, after, 0.06);
      } catch {}

      idxRef.current = startIndex; setIdx(startIndex);
      setEtat("lecture");
    } catch {
      try { radioGainRef.current.gain.setTargetAtTime(1, now + 0.06, 0.06); } catch {}
      const next = (startIndex + 1) % list.length;
      playingLockRef.current = false;
      await playIndex(next, tries + 1);
      return;
    }

    playingLockRef.current = false;
  }

  /* ===== Watchdog anti-boucle ===== */
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
      const cur = scanRef.current[idxRef.current];
      const url = typeof cur === "string" ? cur : cur.url;
      el.pause(); el.src = ""; el.load();
      await sleep(80);
      el.src = withCacheBust(url); el.load();
      await el.play();
      startWatchdog();
      setEtat("lecture");
    } catch {}
  }

  /* ===== Balayage (sans garde-voix) ===== */
  function startSweep() {
    stopSweep();
    const tick = async () => {
      if (!marche) return;
      const list = scanRef.current; if (!list.length) return;
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

  /* ===== LIVE+ : ajout auto de radios parlées (RadioBrowser) ===== */
  useEffect(() => {
    if (!livePlus) return;
    if (augmentingRef.current) return;
    augmentingRef.current = true;

    (async () => {
      try {
        const urls = [
          "https://de1.api.radio-browser.info/json/stations/search?tag=news&hidebroken=true&is_https=true&codec=MP3&limit=200",
          "https://de1.api.radio-browser.info/json/stations/search?tag=talk&hidebroken=true&is_https=true&codec=MP3&limit=200",
          "https://de1.api.radio-browser.info/json/stations/search?language=french&hidebroken=true&is_https=true&codec=MP3&limit=150",
          "https://de1.api.radio-browser.info/json/stations/search?language=english&hidebroken=true&is_https=true&codec=MP3&limit=150"
        ];
        const batches = await Promise.allSettled(urls.map(u => fetch(u, { cache: "no-store" })));
        const found = [];
        for (const b of batches) {
          if (b.status !== "fulfilled") continue;
          const list = await b.value.json();
          (list || []).forEach(item => {
            const url = (item?.url_resolved || item?.url || "").trim();
            if (!/^https:/i.test(url)) return;
            const L = url.toLowerCase();
            if (/\.(m3u8|m3u|pls|xspf)(\?|$)/.test(L)) return;
            found.push({
              name: item?.name || new URL(url).host,
              url,
              type: (item?.tags || "").toLowerCase().includes("news") ? "news" : "talk",
              lang: item?.language || undefined,
              weight: 2
            });
          });
        }

        if (found.length) {
          setStations(prev => {
            const merged = dedupByUrl([...prev, ...found]);
            scanRef.current = buildWeighted(merged);
            setEtat(`LIVE+ ajouté (${merged.length - prev.length})`);
            return merged;
          });
        }
      } catch {
        setEtat("LIVE+ indisponible");
      } finally {
        augmentingRef.current = false;
      }
    })();
  }, [livePlus]);

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
    echoFbRef.current.gain.value = Math.min(0.5, echo * 0.55);
  }, [echo]);
  useEffect(() => {
    if (!auto) { stopSweep(); return; }
    if (marche) startSweep();
    return stopSweep;
  }, [auto, vitesse, marche, bruit]);

  function toggleEnr() { if (!enr) startRecording(); else stopRecording(); }

  /* ===== UI ===== */
  const list = scanRef.current;
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
                <Lamp label="LIVE+"  on={livePlus} colorOn="#86fb6a" />
              </div>
            </div>
          </div>

          <div style={styles.glass}>
            <div style={styles.stationRow}>
              <div><strong>{currentName || "—"}</strong></div>
              <div><em style={{ opacity: 0.9 }}>{etat}</em></div>
            </div>
            {compat && <div style={styles.compatBanner}>Mode compatibilité (CORS) activé.</div>}
          </div>

          <div style={styles.controlsRow}>
            <div style={styles.switches}>
              <Switch label="MARCHE" on={marche} onChange={async v => { setMarche(v); v ? await powerOn() : await powerOff(); }} />
              <Switch label="BALAYAGE AUTO" on={auto} onChange={(v) => setAuto(v)} />
              <Switch label="LIVE+ (annuaire)" on={livePlus} onChange={(v) => setLivePlus(v)} />
              <Bouton label={enr ? (supportsType("audio/mpeg") ? "STOP ENREG. (MP3)" : "STOP ENREG. (WAV)") : "ENREGISTRER"} onClick={toggleEnr} color={enr ? "#f0c14b" : "#d96254"} />
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
        Balayage continu avec lit de bruit modulé. Active <em>LIVE+</em> pour enrichir en radios parlées (MP3/HTTPS).
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
