(() => {
  'use strict';

  /* ---------- Konstanta & helper ---------- */
  const KEY = 'myalarm.alarms.v1', THEME_KEY = 'myalarm.theme';
  const DAYS_SHORT = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  const DAYS_LONG = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const SNOOZE_MS = 5 * 60 * 1000;
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  /* ---------- State ---------- */
  let alarms = store.get(KEY, []);
  let editingId = null;
  let ringing = null;
  let snoozes = [];           // {at, alarm}
  const fired = new Set();    // cegah bunyi ganda dalam menit yang sama
  const save = () => store.set(KEY, alarms);

  /* ---------- Tema ---------- */
  const ICON_MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  const ICON_SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $('themeIcon').innerHTML = t === 'dark' ? ICON_SUN : ICON_MOON;
  }
  applyTheme(store.get(THEME_KEY, 'dark'));
  $('themeBtn').onclick = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(t); store.set(THEME_KEY, t);
  };

  /* ---------- Jam ---------- */
  function updateClock() {
    const d = new Date();
    $('clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    $('date').textContent = `${DAYS_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  /* ---------- Suara (Web Audio) ---------- */
  let audioCtx = null, soundTimer = null;
  function getCtx() {
    if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  // browser memblokir audio sebelum ada interaksi, jadi "buka kunci" saat sentuhan pertama
  ['click', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, () => getCtx(), { once: true }));
  function beep(freq, start, dur) {
    const c = getCtx(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + start;
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  const SOUND_FILE = 'audio/samsung.mpeg';
  const alarmAudio = new Audio(SOUND_FILE);
  alarmAudio.loop = true;
  alarmAudio.preload = 'auto';
  function startBeepFallback() {
    const pattern = () => { beep(880, 0, .15); beep(1100, .22, .15); beep(880, .44, .15); beep(1100, .66, .15); };
    pattern(); soundTimer = setInterval(pattern, 1600);
  }
  function startSound() {
    stopSound();
    alarmAudio.currentTime = 0;
    alarmAudio.play().catch(startBeepFallback);
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
  }
  function stopSound() {
    alarmAudio.pause(); alarmAudio.currentTime = 0;
    clearInterval(soundTimer); soundTimer = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }

  function refreshNotifBanner() {
    const b = $('notifBanner');
    if (!('Notification' in window)) { b.hidden = true; return; }
    const p = Notification.permission;
    b.hidden = p === 'granted';
    if (p === 'denied') {
      $('notifText').textContent = 'Notifikasi diblokir. Aktifkan lewat pengaturan situs di browser. Alarm tetap berbunyi di halaman ini.';
      $('notifBtn').hidden = true;
    } else { $('notifBtn').hidden = false; }
  }
  $('notifBtn').onclick = () => Notification.requestPermission().then(refreshNotifBanner);
  function notify(a) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification('\u23F0 ' + (a.title || 'Alarm'), { body: `Sekarang pukul ${a.time}`, requireInteraction: true }); } catch {}
  }

  function repeatLabel(a) {
    if (a.repeat === 'daily') return 'Setiap hari';
    if (a.repeat === 'custom') {
      const d = [...a.days].sort((x, y) => x - y);
      if (d.length === 7) return 'Setiap hari';
      return d.map(i => DAYS_SHORT[i]).join(', ');
    }
    return 'Sekali';
  }
  const runsToday = (a, d) => a.repeat !== 'custom' || a.days.includes(d.getDay());

  function ring(a) {
    ringing = a;
    $('ringTime').textContent = a.time;
    $('ringName').textContent = a.title || 'Alarm';
    $('ringOverlay').hidden = false;
    $('hero').classList.add('ringing');
    document.title = (a.title || 'Alarm') + ' - My Alarm';
    startSound(); notify(a);
    if (a.repeat === 'once' && !a.snoozed) {   // alarm sekali otomatis nonaktif setelah berbunyi
      const real = alarms.find(x => x.id === a.id);
      if (real) { real.enabled = false; save(); render(); }
    }
    render();
  }
  function dismiss() {
    stopSound(); ringing = null;
    $('ringOverlay').hidden = true;
    $('hero').classList.remove('ringing');
    document.title = 'My Alarm';
    render();
  }
  function snooze() {
    snoozes.push({ at: Date.now() + SNOOZE_MS, alarm: { ...ringing, snoozed: true } });
    dismiss();
  }
  $('stopBtn').onclick = dismiss;
  $('snoozeBtn').onclick = snooze;

  function check() {
    if (ringing) return;
    const now = new Date(), hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const day = now.toDateString();
    const due = snoozes.findIndex(s => s.at <= Date.now());
    if (due > -1) { ring(snoozes.splice(due, 1)[0].alarm); return; }
    for (const a of alarms) {
      const k = `${a.id}|${day}|${hm}`;
      if (a.enabled && a.time === hm && runsToday(a, now) && !fired.has(k)) {
        fired.add(k); ring(a); return;
      }
    }
  }

  function render() {
    const list = $('list');
    if (!alarms.length) {
      list.innerHTML = '<div class="empty">Belum ada alarm.<br>Tekan “+ Tambah Alarm” untuk membuat yang pertama.</div>';
      return;
    }
    const sorted = [...alarms].sort((a, b) => a.time.localeCompare(b.time));
    list.innerHTML = sorted.map(a => `
      <article class="card ${a.enabled ? '' : 'off'} ${ringing && ringing.id === a.id ? 'ring' : ''}" data-id="${a.id}">
        <div class="info">
          <div class="time">${a.time}</div>
          <div class="title">${esc(a.title || 'Alarm')}</div>
          <div class="meta">${esc(repeatLabel(a))}</div>
        </div>
        <button class="switch sw" data-act="toggle" role="switch" aria-checked="${a.enabled}" aria-label="Aktif/nonaktif"></button>
        <div class="actions">
          <button class="mini" data-act="edit">Edit</button>
          <button class="mini del" data-act="delete">Hapus</button>
        </div>
      </article>`).join('');
  }
  $('list').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const card = btn.closest('.card'), id = card.dataset.id, a = alarms.find(x => x.id === id);
    if (!a) return;
    if (btn.dataset.act === 'toggle') { a.enabled = !a.enabled; save(); render(); }
    if (btn.dataset.act === 'edit') openForm(a);
    if (btn.dataset.act === 'delete') {
      card.classList.add('removing');
      setTimeout(() => { alarms = alarms.filter(x => x.id !== id); save(); render(); }, 250);
    }
  });

  /* ---------- Form modal ---------- */
  let formDays = new Set(), formEnabled = true;
  $('fDays').innerHTML = DAYS_SHORT.map((d, i) => `<button type="button" class="day" data-d="${i}">${d}</button>`).join('');
  $('fDays').addEventListener('click', e => {
    const b = e.target.closest('.day'); if (!b) return;
    const d = +b.dataset.d; formDays.has(d) ? formDays.delete(d) : formDays.add(d);
    b.classList.toggle('on', formDays.has(d));
  });
  function syncDays() {
    $('fDays').hidden = $('fRepeat').value !== 'custom';
    document.querySelectorAll('.day').forEach(b => b.classList.toggle('on', formDays.has(+b.dataset.d)));
  }
  $('fRepeat').onchange = syncDays;
  $('fEnabled').onclick = () => { formEnabled = !formEnabled; $('fEnabled').setAttribute('aria-checked', formEnabled); };

  function openForm(a) {
    editingId = a ? a.id : null;
    const n = new Date();
    $('formTitle').textContent = a ? 'Edit Alarm' : 'Tambah Alarm';
    $('fTime').value = a ? a.time : `${pad(n.getHours())}:${pad(n.getMinutes())}`;
    $('fName').value = a ? a.title : '';
    $('fRepeat').value = a ? a.repeat : 'once';
    formDays = new Set(a ? a.days : []);
    formEnabled = a ? a.enabled : true;
    $('fEnabled').setAttribute('aria-checked', formEnabled);
    $('fErr').textContent = '';
    syncDays();
    $('formOverlay').hidden = false;
    setTimeout(() => $('fName').focus(), 50);
  }
  const closeForm = () => { $('formOverlay').hidden = true; editingId = null; };
  $('addBtn').onclick = () => { getCtx(); openForm(null); };
  $('cancelBtn').onclick = closeForm;
  $('formOverlay').addEventListener('click', e => { if (e.target.id === 'formOverlay') closeForm(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('formOverlay').hidden) closeForm(); });

  $('saveBtn').onclick = () => {
    const time = $('fTime').value, repeat = $('fRepeat').value;
    if (!/^\d{2}:\d{2}$/.test(time)) { $('fErr').textContent = 'Pilih jam dan menit terlebih dahulu.'; return; }
    if (repeat === 'custom' && !formDays.size) { $('fErr').textContent = 'Pilih minimal satu hari.'; return; }
    const data = {
      time, repeat, enabled: formEnabled,
      title: $('fName').value.trim() || 'Alarm',
      days: repeat === 'custom' ? [...formDays] : []
    };
    if (editingId) {
      const a = alarms.find(x => x.id === editingId);
      Object.assign(a, data);
      for (const k of [...fired]) if (k.startsWith(editingId + '|')) fired.delete(k);  // izinkan bunyi lagi setelah diedit
    } else alarms.push({ id: uid(), ...data });
    save(); closeForm(); render();
    if ('Notification' in window && Notification.permission === 'default') refreshNotifBanner();
  };

  /* ---------- Init ---------- */
  refreshNotifBanner();
  render(); updateClock();
  setInterval(() => { updateClock(); check(); }, 1000);
})();
