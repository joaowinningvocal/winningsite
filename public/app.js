/* WinningVocal — front-end logic */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const LK = window.LivekitClient || window.LiveKitClient || null;
  const MAX_TESTS = 2;

  /* ---------- Mobile nav ---------- */
  const nav = $('#nav');
  const navToggle = $('#navToggle');
  navToggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
  });
  $$('.nav__links a').forEach((a) =>
    a.addEventListener('click', () => {
      nav.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    })
  );

  /* ---------- Hero wave bars (decorative) ---------- */
  const heroWave = $('#heroWave');
  if (heroWave) {
    const heights = [40, 70, 55, 95, 60, 80, 45, 100, 65, 50, 85, 58, 72, 48, 90, 62];
    heights.forEach((h, i) => {
      const s = document.createElement('span');
      s.style.height = h + '%';
      s.style.animationDelay = (i * 0.08).toFixed(2) + 's';
      s.style.animationDuration = (1.0 + (i % 5) * 0.16).toFixed(2) + 's';
      heroWave.appendChild(s);
    });
  }

  /* ---------- Client logo fade carousel ---------- */
  (function logoCarousel() {
    const slides = $$('#logoStage .logo-slide');
    const dotsWrap = $('#logoDots');
    if (!slides.length || !dotsWrap) return;
    let idx = 0;
    let timer = null;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    slides.forEach((_, i) => {
      const b = document.createElement('button');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', 'Show client ' + (i + 1));
      if (i === 0) b.classList.add('active');
      b.addEventListener('click', () => go(i, true));
      dotsWrap.appendChild(b);
    });
    const dots = $$('button', dotsWrap);

    function go(n, manual) {
      slides[idx].classList.remove('active');
      dots[idx].classList.remove('active');
      idx = (n + slides.length) % slides.length;
      slides[idx].classList.add('active');
      dots[idx].classList.add('active');
      if (manual) restart();
    }
    function next() { go(idx + 1, false); }
    function restart() {
      if (timer) clearInterval(timer);
      if (!reduce) timer = setInterval(next, 2600);
    }
    restart();
  })();

  /* ================= LIVE DEMO ================= */
  const demoStatus = $('#demoStatus');
  const startBtn = $('#startCallBtn');
  const endBtn = $('#endCallBtn');
  const fullNameEl = $('#dFullName');
  const bizEl = $('#dBusiness');
  const demoForm = $('#demoForm');
  const demoLive = $('#demoLive');
  const countEl = $('#demoCount');
  const countLiveEl = $('#demoCountLive');
  const canvas = $('#demoCanvas');
  const ctx = canvas.getContext('2d');

  let room = null;
  let audioCtx = null;
  let analyser = null;
  let freqData = null;
  let isLive = false;
  let dpr = 1;
  let demoConfigured = true;

  const getCount = () => parseInt(sessionStorage.getItem('wv_demo_calls') || '0', 10);
  const setCount = (n) => sessionStorage.setItem('wv_demo_calls', String(n));

  function updateCountLabels() {
    const left = Math.max(0, MAX_TESTS - getCount());
    const txt = left > 0 ? `${left} free test${left === 1 ? '' : 's'} left` : 'Test limit reached';
    if (countEl) countEl.textContent = txt;
    if (countLiveEl) countLiveEl.textContent = 'Live now';
  }

  function setStatus(text, color) {
    demoStatus.innerHTML =
      `<span class="pulse-dot" style="background:${color || '#c9b8ec'};"></span> ` + text;
  }

  /* ----- canvas sizing + draw loop (ambient always, reactive when live) ----- */
  function sizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }
  function rr(x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); return; }
    ctx.fillRect(x, y, w, h);
  }
  function draw() {
    const w = canvas.width, h = canvas.height, mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    const bars = 64;
    const gap = 3 * dpr;
    const bw = (w - gap * (bars - 1)) / bars;
    if (isLive && analyser) analyser.getByteFrequencyData(freqData);
    const t = performance.now() / 1000;

    let grad;
    if (isLive) {
      grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#ffd2d4');
      grad.addColorStop(1, '#ec2229');
    } else {
      grad = 'rgba(255,255,255,0.34)';
    }
    ctx.fillStyle = grad;

    for (let i = 0; i < bars; i++) {
      let v;
      if (isLive && analyser) {
        const idx = Math.floor((i / bars) * (freqData.length * 0.72));
        v = freqData[idx] / 255;
        v = Math.pow(v, 0.85);
      } else {
        v = 0.10 + 0.12 * (0.5 + 0.5 * Math.sin(t * 2.1 + i * 0.34));
      }
      const barH = Math.max(2 * dpr, v * (h * 0.9));
      const x = i * (bw + gap);
      rr(x, mid - barH / 2, bw, barH, Math.min(bw / 2, 6 * dpr));
    }
    requestAnimationFrame(draw);
  }
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);
  requestAnimationFrame(draw);

  /* ----- enable Start only when both fields filled ----- */
  function refreshStartEnabled() {
    if (getCount() >= MAX_TESTS) { startBtn.disabled = false; return; } // stays clickable to open modal
    startBtn.disabled = !(fullNameEl.value.trim() && bizEl.value.trim());
  }
  fullNameEl.addEventListener('input', refreshStartEnabled);
  bizEl.addEventListener('input', refreshStartEnabled);

  /* ----- attach remote audio + build analyser ----- */
  function handleTrack(track) {
    if (track.kind !== 'audio') return;
    // Play the agent audio
    const el = track.attach();
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.style.display = 'none';
    document.body.appendChild(el);
    // Tap the same stream for the visualizer
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const src = audioCtx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser); // analyser not connected to destination -> no double audio
    } catch (e) { /* visualizer is best-effort */ }
  }

  /* ----- start / end a call ----- */
  async function startCall() {
    if (getCount() >= MAX_TESTS) { openHumanModal(); return; }
    if (!demoConfigured) {
      setStatus('Demo not configured yet — please use the contact form below.', '#ffb84d');
      return;
    }
    if (!LK) {
      setStatus('Couldn’t load the call library. Check your connection and retry.', '#ffb84d');
      return;
    }
    startBtn.disabled = true;
    setStatus('Connecting…', '#ffd166');

    let details;
    try {
      const res = await fetch('/api/create-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullNameEl.value.trim(),
          business_type: bizEl.value.trim(),
        }),
      });
      details = await res.json();
      if (!res.ok) throw new Error(details.error || 'Could not start the call.');
    } catch (err) {
      setStatus(err.message || 'Could not start the call. Please try again.', '#ff6b6b');
      refreshStartEnabled();
      return;
    }

    if (!details.url || !details.access_token) {
      setStatus('The call service returned an unexpected response.', '#ff6b6b');
      refreshStartEnabled();
      return;
    }

    try {
      room = new LK.Room({ adaptiveStream: true, dynacast: true });
      room.on(LK.RoomEvent.TrackSubscribed, (track) => handleTrack(track));
      room.on(LK.RoomEvent.Disconnected, () => endCall(true));

      await room.connect(details.url, details.access_token);
      await room.localParticipant.setMicrophoneEnabled(true);

      isLive = true;
      demoForm.classList.add('hidden');
      demoLive.classList.remove('hidden');
      setStatus('Connected — say hello 👋', '#58e07a');
      updateCountLabels();
    } catch (err) {
      let msg = 'Could not connect. Please try again.';
      if (err && /permission|denied|NotAllowed/i.test(String(err.name || err.message)))
        msg = 'Microphone access is needed for the call. Enable it and retry.';
      setStatus(msg, '#ff6b6b');
      try { if (room) await room.disconnect(); } catch (e) {}
      room = null;
      refreshStartEnabled();
    }
  }

  async function endCall(fromEvent) {
    if (!isLive && !room) return;
    isLive = false;
    analyser = null;
    try { if (room && !fromEvent) await room.disconnect(); } catch (e) {}
    room = null;

    // count this completed test
    const n = getCount() + 1;
    setCount(n);

    demoLive.classList.add('hidden');
    demoForm.classList.remove('hidden');
    updateCountLabels();

    if (n >= MAX_TESTS) {
      setStatus('That’s enough tests for now', '#c9b8ec');
      startBtn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c0-4 4-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Talk to a human';
      startBtn.disabled = false;
      openHumanModal();
    } else {
      setStatus('Call ended — start another whenever you like', '#c9b8ec');
      refreshStartEnabled();
    }
  }

  startBtn.addEventListener('click', startCall);
  endBtn.addEventListener('click', () => endCall(false));

  /* ---------- Human-rep modal ---------- */
  const humanModal = $('#humanModal');
  function openHumanModal() {
    // prefill from the demo form if we have it
    if (fullNameEl.value.trim() && !$('#hName').value) $('#hName').value = fullNameEl.value.trim();
    humanModal.classList.add('open');
    humanModal.setAttribute('aria-hidden', 'false');
  }
  function closeHumanModal() {
    humanModal.classList.remove('open');
    humanModal.setAttribute('aria-hidden', 'true');
  }
  $$('[data-close]', humanModal).forEach((el) => el.addEventListener('click', closeHumanModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && humanModal.classList.contains('open')) closeHumanModal();
  });

  /* ---------- Webhook submit helper ---------- */
  async function submitContact(payload, btn, msgEl) {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email || '');
    if (!payload.name || !emailOk) {
      msgEl.textContent = 'Please enter your name and a valid email.';
      msgEl.className = 'form-msg err';
      return;
    }
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    msgEl.textContent = '';
    msgEl.className = 'form-msg';
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      msgEl.textContent = 'Thanks! We’ll be in touch shortly.';
      msgEl.className = 'form-msg ok';
      return true;
    } catch (err) {
      msgEl.textContent = err.message || 'Could not submit. Please try again.';
      msgEl.className = 'form-msg err';
      return false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  /* contact form */
  const contactBtn = $('#contactSubmit');
  contactBtn.addEventListener('click', async () => {
    const ok = await submitContact(
      {
        name: $('#cName').value.trim(),
        email: $('#cEmail').value.trim(),
        phone: $('#cPhone').value.trim(),
        message: $('#cMsg').value.trim(),
        source: 'contact-form',
      },
      contactBtn,
      $('#contactMsg')
    );
    if (ok) ['#cName', '#cEmail', '#cPhone', '#cMsg'].forEach((s) => ($(s).value = ''));
  });

  /* human-rep modal form */
  const humanBtn = $('#humanSubmit');
  humanBtn.addEventListener('click', async () => {
    const ok = await submitContact(
      {
        name: $('#hName').value.trim(),
        email: $('#hEmail').value.trim(),
        message: $('#hMsg').value.trim(),
        source: 'talk-to-human-after-demo',
      },
      humanBtn,
      $('#humanMsg')
    );
    if (ok) setTimeout(closeHumanModal, 1400);
  });

  /* ---------- Check demo config on load ---------- */
  fetch('/api/config')
    .then((r) => r.json())
    .then((c) => {
      demoConfigured = Boolean(c.demoConfigured);
      if (!demoConfigured) setStatus('Live demo coming online soon', '#c9b8ec');
    })
    .catch(() => {});

  updateCountLabels();
})();
