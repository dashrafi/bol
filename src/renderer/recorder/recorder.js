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
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }

  // Virtual audio devices (SteelSeries Sonar, OBS, Voicemeeter, VB-Cable, NDI…)
  // are silent unless their routing app is configured — a "default" that points at
  // one records pure silence. Prefer a REAL microphone when the user hasn't
  // explicitly picked a device.
  const VIRTUAL_RX = /virtual|sonar|voicemeeter|vb-audio|cable|obs|ndi|anydesk|steam streaming|loopback/i;
  let smartId = null; // cached pick; invalidated on device changes
  try {
    navigator.mediaDevices.addEventListener('devicechange', () => { smartId = null; });
  } catch (_) { /* older API — cache just lives longer */ }

  async function pickRealMicId() {
    if (smartId !== null) return smartId;
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch (_) { return (smartId = ''); }
    // Labels unlock only after one successful getUserMedia — poke if needed.
    if (devices.length && devices.every((d) => !d.label)) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
        devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      } catch (_) { return (smartId = ''); }
    }
    const named = devices.filter((d) => d.label && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const real = named.filter((d) => !VIRTUAL_RX.test(d.label));
    // Among real mics prefer obvious hardware names; else first real; else give up (system default).
    const preferred = real.find((d) => /array|realtek|intel|usb|headset|webcam|camera/i.test(d.label)) || real[0];
    smartId = preferred ? preferred.deviceId : '';
    return smartId;
  }

  async function getStream(deviceId) {
    const audio = baseAudioConstraints();
    let wantExact = deviceId && deviceId !== 'default';
    if (wantExact) {
      audio.deviceId = { exact: deviceId };
    } else {
      const real = await pickRealMicId();
      if (real) { audio.deviceId = { exact: real }; wantExact = true; }
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      // The chosen device may have been unplugged since it was selected —
      // fall back to the system default rather than failing the dictation.
      const n = (err && err.name) || '';
      if (wantExact && (n === 'OverconstrainedError' || n === 'ConstraintNotSatisfiedError' || n === 'NotFoundError')) {
        smartId = null;
        return navigator.mediaDevices.getUserMedia({ audio: baseAudioConstraints() });
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

      const session = { stream, ctx, source, gain, node, closed: false, onStopped: null };

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

  async function stopRecording() {
    const s = rec;
    if (!s) return; // idempotent
    rec = null;
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
})();
