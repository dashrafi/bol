// Bol — recorder window script (plain browser JS, uses the window.bol bridge).
// Owns mic capture: getUserMedia -> GainNode -> AudioWorklet downsampler ->
// forwards PCM16 frames to main via 'audio:chunk', RMS levels via 'audio:level'.
// Also services 'mic:enumerate' requests from main.
'use strict';

(() => {
  const bol = window.bol;

  let rec = null;                 // active session: { stream, ctx, source, gain, node, closed }
  let chain = Promise.resolve();  // serializes start/stop so restarts never interleave
  let lastLevelTs = 0;            // 60 ms throttle for 'audio:level'

  // ---------- error messages ----------
  function humanError(err) {
    const name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return 'Microphone access denied — allow microphone access for Bol in Windows Settings > Privacy > Microphone';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone found — connect or enable a microphone and try again';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return 'The selected microphone is unavailable — choose a different mic in Settings';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return 'Microphone is busy or unavailable — another app may be using it';
    }
    return 'Microphone error: ' + ((err && err.message) || 'unknown error');
  }

  // ---------- capture ----------
  function baseAudioConstraints() {
    // Tuned for speech RECOGNITION, not for calls:
    // - echoCancellation OFF: there is no far-end to cancel while dictating, and
    //   the AEC filter audibly colours the mic signal.
    // - autoGainControl OFF: it pumps level mid-sentence, which smears the quiet
    //   consonants Whisper relies on (Bol has its own fixed gain setting).
    // - noiseSuppression ON: steady room/fan noise genuinely hurts accuracy.
    return {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 48000,
    };
  }

  // Choosing a microphone by NAME is not enough: virtual devices (SteelSeries
  // Sonar, OBS, Voicemeeter…) and idle Bluetooth headsets happily open and then
  // deliver pure digital silence — which looked exactly like "Bol can't hear me".
  // So candidates are PROBED: we open each one briefly and keep the first that
  // actually produces signal. The winner is cached; a silent session or a device
  // change invalidates it.
  const VIRTUAL_RX = /virtual|sonar|voicemeeter|vb-audio|cable|obs|ndi|anydesk|steam streaming|loopback/i;
  const PROBE_MS = 700;           // long enough to catch a device that never wakes
  const PROBE_SILENCE = 0.00005;  // a live mic's raw noise floor clears this; a dead device returns exact 0
  let goodId = null;             // verified working deviceId ('' = system default)
  let probing = null;            // in-flight probe promise (dedupe)

  try {
    navigator.mediaDevices.addEventListener('devicechange', () => { goodId = null; });
  } catch (_) { /* older API — cache just lives longer */ }

  async function listInputs() {
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch (_) { return []; }
    if (devices.length && devices.every((d) => !d.label)) {
      // Labels unlock only after one successful getUserMedia — poke once.
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
        devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      } catch (_) { /* keep unlabeled list */ }
    }
    return devices;
  }

  // Open one device and report its peak level over PROBE_MS.
  // Probing uses RAW audio on purpose: noiseSuppression zeroes out a quiet room,
  // which makes every microphone look dead. With the processing off, a live mic
  // always shows its analogue noise floor (~0.001+) while a dead device (idle
  // Bluetooth, unconfigured virtual driver) returns literal digital zero.
  async function probe(deviceId) {
    let stream = null, ctx = null;
    try {
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (deviceId) audio.deviceId = { exact: deviceId };
      stream = await navigator.mediaDevices.getUserMedia({ audio });
      ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(an);
      const data = new Float32Array(an.fftSize);
      let peak = 0;
      const until = Date.now() + PROBE_MS;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
        an.getFloatTimeDomainData(data); // float: resolves the tiny noise floor a byte view rounds to zero
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
        }
      }
      return peak;
    } catch (_) {
      return -1; // could not open
    } finally {
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { if (ctx) await ctx.close(); } catch (_) {}
    }
  }

  // Probe candidates in a sensible order and cache the first that hears anything.
  function findWorkingMic() {
    if (probing) return probing;
    probing = (async () => {
      const devices = await listInputs();
      const named = devices.filter((d) => d.label && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
      const real = named.filter((d) => !VIRTUAL_RX.test(d.label));
      const ordered = [];
      // built-in/wired hardware first (a docked-but-idle Bluetooth headset is the
      // classic silent device), then any other real mic, then the system default
      real.filter((d) => /array|realtek|intel|usb|webcam|camera/i.test(d.label)).forEach((d) => ordered.push(d));
      real.forEach((d) => { if (ordered.indexOf(d) === -1) ordered.push(d); });
      let best = { id: null, peak: -1, label: '' };
      for (const d of ordered) {
        const peak = await probe(d.deviceId);
        if (peak > best.peak) best = { id: d.deviceId, peak: peak, label: d.label };
        if (peak > PROBE_SILENCE) break; // live: it shows a real noise floor
      }
      // The system default is only a fallback, and only when it is NOT a virtual
      // device: on this machine Windows' default is a virtual mixer mic that opens
      // fine and then delivers pure silence, which is what "Bol can't hear me" was.
      if (best.peak <= PROBE_SILENCE) {
        const sysIsVirtual = named.length > 0 && real.length < named.length &&
          !real.some((d) => d.deviceId === 'default');
        if (!sysIsVirtual || real.length === 0) {
          const sys = await probe('');
          if (sys > best.peak) best = { id: '', peak: sys, label: 'system default' };
        }
        if (best.id === null && real.length) best = { id: real[0].deviceId, peak: 0, label: real[0].label + ' (unverified)' };
      }
      goodId = best.id === null ? '' : best.id;
      bol.send('mic:picked', { label: best.label || 'system default', peak: Math.round(best.peak * 100000) / 100000, deviceId: goodId });
      return goodId;
    })().catch(() => (goodId = '')).then((v) => { probing = null; return v; });
    return probing;
  }

  async function getStream(deviceId) {
    const audio = baseAudioConstraints();
    let wantExact = deviceId && deviceId !== 'default';
    if (wantExact) {
      audio.deviceId = { exact: deviceId }; // the user picked this one explicitly — honour it
    } else if (goodId) {
      audio.deviceId = { exact: goodId };   // verified to actually produce audio
      wantExact = true;
    } else {
      // Never make the user wait on a probe: open the system default now and let
      // the probe run in the background so the NEXT capture uses a verified mic.
      findWorkingMic();
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      // The chosen device is gone (a Bluetooth headset leaving Hands-Free mode
      // disappears exactly like this). Do NOT blindly fall back to the system
      // default — on this machine that is a virtual mixer mic that returns pure
      // silence. Fall back to a PROBED, verified device and tell main to clear
      // the stale setting so Settings stops pointing at a device that is gone.
      const n = (err && err.name) || '';
      if (wantExact && (n === 'OverconstrainedError' || n === 'ConstraintNotSatisfiedError' || n === 'NotFoundError')) {
        goodId = null;
        if (deviceId && deviceId !== 'default') bol.send('mic:stale', { deviceId: deviceId });
        const verified = await findWorkingMic();
        const retry = baseAudioConstraints();
        if (verified) retry.deviceId = { exact: verified };
        return navigator.mediaDevices.getUserMedia({ audio: retry });
      }
      throw err;
    }
  }

  async function startRecording(opts) {
    await stopRecording(); // rec:start while recording -> clean restart
    const o = opts || {};
    let stream = null;
    let ctx = null;
    try {
      stream = await getStream(o.deviceId);

      ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('worklet.js');
      if (ctx.state === 'suspended') await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);

      const gain = ctx.createGain();
      const g = (typeof o.gain === 'number' && isFinite(o.gain) && o.gain > 0) ? o.gain : 1.0;
      gain.gain.value = g * (o.whisperMode ? 3.0 : 1.0);

      const node = new AudioWorkletNode(ctx, 'bol-downsampler', {
        numberOfInputs: 1,
        numberOfOutputs: 1, // processor never writes output — silent, keeps the graph pulled
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });

      const session = { stream, ctx, source, gain, node, closed: false, onStopped: null, peakRms: 0, deviceId: (audioTrackId(stream) || '') };

      node.port.onmessage = (e) => {
        const msg = e.data;
        if (msg && msg.type === 'stopped') {
          // Worklet acked the stop: its tail frame (if any) was posted before
          // this message, so teardown can proceed immediately.
          if (session.onStopped) session.onStopped();
          return;
        }
        if (!msg || msg.type !== 'frame' || session.closed) return;
        if (msg.buffer && msg.buffer.byteLength > 0) bol.send('audio:chunk', msg.buffer);
        if ((msg.rms || 0) > session.peakRms) session.peakRms = msg.rms;
        const now = Date.now();
        if (now - lastLevelTs >= 60) {
          lastLevelTs = now;
          const level = Math.min(1, Math.max(0, (msg.rms || 0) * 4));
          bol.send('audio:level', level);
        }
      };

      source.connect(gain);
      gain.connect(node);
      node.connect(ctx.destination); // output is silent; connection keeps processing alive

      // Surface mid-recording device loss (unplugged mic). Programmatic
      // track.stop() does not fire 'ended', so this only reports real losses.
      const tracks = stream.getAudioTracks();
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].onended = () => {
          if (rec === session && !session.closed) bol.send('audio:error', 'Microphone disconnected');
        };
      }

      rec = session;
    } catch (err) {
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { if (ctx) await ctx.close(); } catch (_) {}
      rec = null;
      bol.send('audio:error', humanError(err));
    }
  }

  function audioTrackId(stream) {
    try {
      const t = stream.getAudioTracks()[0];
      const s = t && t.getSettings ? t.getSettings() : null;
      return (s && s.deviceId) || '';
    } catch (_) { return ''; }
  }

  async function stopRecording() {
    const s = rec;
    if (!s) return; // idempotent
    rec = null;
    // A session that produced digital silence means the device we used is dead
    // (idle Bluetooth headset, unconfigured virtual mic). Drop it from the cache
    // and re-probe in the background so the next dictation uses a live mic.
    if (s.peakRms < 0.0015) {
      if (goodId && goodId === s.deviceId) goodId = null;
      bol.send('audio:silent', { deviceId: s.deviceId });
      findWorkingMic();
    }
    // Ask the worklet to flush its partial tail frame, then wait for its
    // 'stopped' ack (port messages are ordered, so the tail frame lands
    // first). Time out defensively in case the audio thread is already gone.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      s.onStopped = finish;
      try { s.node.port.postMessage({ type: 'stop' }); } catch (_) { finish(); }
      setTimeout(finish, 250);
    });
    s.closed = true;
    try { s.node.port.onmessage = null; } catch (_) {}
    try { s.source.disconnect(); } catch (_) {}
    try { s.gain.disconnect(); } catch (_) {}
    try { s.node.disconnect(); } catch (_) {}
    try { s.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { await s.ctx.close(); } catch (_) {}
  }

  // ---------- device enumeration ----------
  async function listMics() {
    let inputs = [];
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter((d) => d.kind === 'audioinput');
      // Labels are blank until getUserMedia has succeeded once — poke the mic
      // briefly to unlock them (skip while a real capture is running).
      const unlabeled = inputs.length > 0 && inputs.every((d) => !d.label);
      if (unlabeled && !rec) {
        try {
          const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
          tmp.getTracks().forEach((t) => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          inputs = devices.filter((d) => d.kind === 'audioinput');
        } catch (_) { /* keep the unlabeled list */ }
      }
    } catch (_) {
      inputs = [];
    }
    return inputs.map((d, i) => ({
      deviceId: d.deviceId || 'default',
      label: d.label || 'Microphone ' + (i + 1),
    }));
  }

  // ---------- IPC wiring ----------
  bol.on('rec:start', (opts) => {
    chain = chain.then(() => startRecording(opts)).catch(() => {});
  });

  bol.on('rec:stop', () => {
    chain = chain.then(() => stopRecording()).catch(() => {});
  });

  bol.on('mic:enumerate', () => {
    listMics()
      .then((list) => bol.send('mic:devices', list))
      .catch(() => bol.send('mic:devices', []));
  });

  bol.on('mic:reprobe', () => { goodId = null; findWorkingMic(); });

  // Find a mic that actually hears something now, while the user is nowhere near
  // pressing the hotkey — so the very first dictation already uses a live device.
  setTimeout(function () { findWorkingMic(); }, 1500);
})();
