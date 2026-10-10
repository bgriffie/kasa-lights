/* Kasa Lights. Talks to the lights relay (kasa_bridge.py in bgriffie/phosphor-os/bridge) running on a
   computer at home, reached over HTTPS through Tailscale. The relay talks to the Kasa bulbs.
   Same relay, API and link as the Lights app in Phosphor OS. */
PH.init({ partyMode: 'strobe', partySpeed: 'medium' });
(() => {
  const $ = s => document.querySelector(s);
  const KEY = 'kasa-lights:data:';   // every tool shares bgriffie.github.io, so keys are prefixed
  const load = (k, d) => { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch {} };

  // Reuse a link already pasted into Phosphor OS (same origin, e.g. when this runs inside the OS)
  const osLink = () => { try { return JSON.parse(localStorage.getItem('phosphor-os:data:lights-link')); } catch { return null; } };
  let link = load('link', null) || osLink();   // { url, key }
  let lights = load('cache', []), openId = load('open', null), lastOk = 0, failing = false;
  const ready = () => !!(link && link.url && link.key);
  const route = () => (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/';

  // "https://pc.tailnet.ts.net#key" (what the relay prints)
  function parseLink(s) {
    const m = /^\s*(https?:\/\/[^\s#]+?)\/?#([\w-]{8,})\s*$/.exec(s || '');
    return m ? { url: m[1], key: m[2] } : null;
  }

  async function call(path, body) {
    if (!ready()) throw new Error('Lights aren\'t set up yet.');
    let r;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
    try {
      r = await fetch(link.url + path, { method: body ? 'POST' : 'GET', signal: ctl.signal, cache: 'no-store',
        headers: { Authorization: 'Bearer ' + link.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error(navigator.onLine === false ? 'No internet connection.' : 'Can\'t reach the lights relay. Is the computer on, and Tailscale on here?');
    } finally { clearTimeout(t); }
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('The relay rejected the key. Paste the Lights link again.');
    if (!r.ok) throw new Error(d.error || 'Relay error ' + r.status);
    return d;
  }

  const note = t => { $('#li-note').textContent = t || ''; $('#li-note').hidden = !t; };
  async function refresh(scan) {
    try {
      const d = await call(scan ? '/lights/rescan' : '/lights', scan ? {} : undefined);
      lights = d.lights || []; save('cache', lights); lastOk = Date.now(); failing = false; note('');
      if (scan) PH.toast(lights.length + ' light' + (lights.length === 1 ? '' : 's') + ' found.');
    } catch (e) { failing = true; note(e.message); if (scan) PH.toast(e.message, 'warn'); }
    render();
  }
  const merge = d => { const i = lights.findIndex(x => x.id === d.id); if (i >= 0) lights[i] = d; else lights.push(d); save('cache', lights); };
  async function set(id, body) {
    const l = lights.find(x => x.id === id); if (!l) return;
    Object.assign(l, 'on' in body ? { on: body.on } : {}, 'brightness' in body ? { brightness: body.brightness, on: true } : {});
    if (body.hsv) { l.hsv = body.hsv; l.temp = 0; l.on = true; }
    if (body.temp) { l.temp = body.temp; l.on = true; }
    render();
    try {
      // a colour or brightness change on an off bulb turns it on
      const send = 'on' in body ? body : { ...body, on: true };
      merge(await call('/lights/' + encodeURIComponent(id), send)); note('');
    } catch (e) { note(e.message); PH.toast(e.message, 'warn'); refresh(); return; }
    render();
  }
  async function all(on) {
    if (!ready()) { PH.go('/settings/relay'); return; }
    lights.forEach(l => { if (l.online) l.on = on; }); render();
    try { const d = await call('/lights/all', { on }); lights = d.lights || lights; save('cache', lights); note(''); }
    catch (e) { note(e.message); PH.toast(e.message, 'warn'); }
    render();
  }
  const anyOn = () => lights.some(l => l.on && l.online);

  /* ---------- Rendering ---------- */
  // The colour a bulb is showing, for its dot
  function tint(l) {
    if (!l.on || !l.online) return '';
    if (l.hsv && !l.temp) return `hsl(${l.hsv[0]} ${Math.max(40, l.hsv[1])}% 55%)`;
    if (l.temp) { const t = Math.max(0, Math.min(1, (l.temp - 2500) / 4000)); return `hsl(${38 - t * 8} ${90 - t * 80}% ${62 + t * 20}%)`; }
    return 'var(--accent)';
  }
  const pct = l => !l.online ? 'Not responding' : !l.on ? 'Off' : l.brightness != null ? l.brightness + '%' : 'On';
  function card(l) {
    const c = document.createElement('div'); c.className = 'li-card' + (l.on && l.online ? ' is-on' : '') + (l.online ? '' : ' is-offline'); c.dataset.id = l.id;
    c.innerHTML = `<div class="li-top"><button class="li-main" data-li-open aria-label="More controls"><span class="li-dot"></span><span class="li-name"></span><small class="li-sub"></small></button>
      <input type="checkbox" role="switch" class="mi-switch" data-li-toggle aria-label="On"></div>`;
    c.querySelector('.li-name').textContent = l.name;
    c.querySelector('.li-sub').textContent = pct(l);
    c.querySelector('.li-dot').style.background = tint(l);
    const sw = c.querySelector('[data-li-toggle]'); sw.checked = !!l.on; sw.disabled = !l.online;
    if (l.brightness != null) {
      const r = document.createElement('input'); r.type = 'range'; r.className = 'li-range'; r.min = 1; r.max = 100; r.value = l.brightness;
      r.dataset.liDim = ''; r.setAttribute('aria-label', l.name + ' brightness'); r.disabled = !l.online; c.appendChild(r);
    }
    return c;
  }
  let dragging = false;
  function render() {
    $('#li-off').hidden = ready(); $('#li-on').hidden = !ready();
    if (!dragging) {
      const box = $('#li-list'); box.textContent = '';
      if (ready() && !lights.length) box.innerHTML = `<p class="menu-note">${failing ? 'No lights to show yet.' : lastOk ? 'The relay didn\'t find any Kasa lights. Make sure the computer is on the same Wi-Fi, then tap Rescan in Settings.' : 'Looking for lights…'}</p>`;
      lights.forEach(l => box.appendChild(card(l)));
      renderOne();
    }
    $('#li-status').textContent = !ready() ? 'Not set up' : failing ? 'Can\'t reach' : lastOk ? 'Connected' : 'Connecting…';
    $('#li-status').className = 'mi-value' + (ready() && !failing && lastOk ? ' t-accent' : '');
    $('#li-forget').hidden = !ready();
    $('#li-count').textContent = ready() ? String(lights.length) : '—';
    const pk = $('#k-power'), one = route() === '/light' && lights.find(x => x.id === openId);
    pk.disabled = !ready() || (one ? !one.online : false);
    pk.setAttribute('aria-pressed', String(one ? !!one.on : anyOn()));
    pk.setAttribute('aria-label', one ? (one.on ? 'Turn off' : 'Turn on') : anyOn() ? 'All off' : 'All on');
  }
  const SWATCH = [['Green', 125, 85], ['Cyan', 185, 90], ['Blue', 225, 95], ['Purple', 275, 85], ['Pink', 320, 75], ['Red', 0, 95], ['Orange', 28, 95], ['Gold', 45, 85]];
  const WHITES = [['Warm', 2700], ['Soft', 3500], ['Neutral', 4500], ['Daylight', 6500]];
  function renderOne() {
    const l = lights.find(x => x.id === openId), v = $('#li-one');
    if (!l) { v.innerHTML = '<p class="menu-note">That light is gone. Go back and pick another.</p>'; return; }
    v.innerHTML = `<div class="li-card big${l.on && l.online ? ' is-on' : ''}" data-id=""><div class="li-top"><div class="li-main"><span class="li-dot"></span><span class="li-name"></span><small class="li-sub"></small></div>
      <input type="checkbox" role="switch" class="mi-switch" data-li-toggle aria-label="On"></div></div>`;
    const c = v.firstChild; c.dataset.id = l.id;
    c.querySelector('.li-name').textContent = l.name; c.querySelector('.li-sub').textContent = pct(l) + (l.model ? ' · ' + l.model : '');
    c.querySelector('.li-dot').style.background = tint(l);
    const sw = c.querySelector('[data-li-toggle]'); sw.checked = !!l.on; sw.disabled = !l.online;
    const group = (title, cls) => { const g = document.createElement('div'); g.className = 'menu-group'; g.innerHTML = `<span class="label"></span><div class="${cls}"></div>`; g.firstChild.textContent = title; v.appendChild(g); return g.lastChild; };
    if (l.brightness != null) {
      const r = document.createElement('input'); r.type = 'range'; r.className = 'li-range'; r.min = 1; r.max = 100; r.value = l.brightness; r.dataset.liDim = ''; r.dataset.id = l.id;
      r.setAttribute('aria-label', 'Brightness'); r.disabled = !l.online; group('Brightness ' + l.brightness + '%', 'li-dimrow').appendChild(r);
    }
    if (l.hsv) {
      const g = group('Colour', 'li-swatches');
      SWATCH.forEach(([n, h, s]) => { const b = document.createElement('button'); b.className = 'li-sw'; b.dataset.liHsv = h + ',' + s; b.dataset.id = l.id; b.setAttribute('aria-label', n);
        b.style.background = `hsl(${h} ${s}% 55%)`; if (!l.temp && Math.abs(l.hsv[0] - h) < 6 && l.on) b.classList.add('is-sel'); b.disabled = !l.online; g.appendChild(b); });
    }
    if (l.tempRange) {
      const g = group('White', 'li-whites');
      WHITES.forEach(([n, k]) => { const kk = Math.max(l.tempRange[0], Math.min(l.tempRange[1], k)); const b = document.createElement('button'); b.className = 'btn'; b.textContent = n;
        b.dataset.liTemp = kk; b.dataset.id = l.id; if (l.temp && Math.abs(l.temp - kk) < 200 && l.on) b.classList.add('is-sel'); b.disabled = !l.online; g.appendChild(b); });
    }
  }

  /* ---------- Wiring ---------- */
  const idOf = el => el.dataset.id || el.closest('[data-id]')?.dataset.id;
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-li-toggle]')) set(idOf(t), { on: t.checked });
    else if (t.matches('[data-li-dim]')) { dragging = false; set(idOf(t), { brightness: +t.value }); }
  });
  document.addEventListener('input', e => {
    if (!e.target.matches('[data-li-dim]')) return;
    dragging = true;
    const card = e.target.closest('.li-card'); if (card) card.querySelector('.li-sub').textContent = e.target.value + '%';
    const lab = e.target.closest('.menu-group')?.querySelector('.label'); if (lab) lab.textContent = 'Brightness ' + e.target.value + '%';
  });
  document.addEventListener('click', e => {
    const o = e.target.closest('[data-li-open]');
    if (o) { openId = idOf(o); save('open', openId); renderOne(); PH.go('/light'); return; }
    const sw = e.target.closest('[data-li-hsv]');
    if (sw) { const [h, s] = sw.dataset.liHsv.split(',').map(Number); const l = lights.find(x => x.id === idOf(sw)); set(idOf(sw), { hsv: [h, s, (l && l.brightness) || 80] }); return; }
    const w = e.target.closest('[data-li-temp]');
    if (w) { set(idOf(w), { temp: +w.dataset.liTemp }); return; }
    const a = e.target.closest('[data-li-all]');
    if (a) all(a.dataset.liAll === 'on');
  });
  // Power key: all lights on Home, the open light on its own page
  $('#k-power').addEventListener('click', () => {
    const l = route() === '/light' && lights.find(x => x.id === openId);
    if (l) set(l.id, { on: !l.on }); else all(!anyOn());
  });
  $('#li-save').addEventListener('click', async () => {
    const p = parseLink($('#li-link').value);
    if (!p) { $('#li-link').setAttribute('aria-invalid', 'true'); PH.toast('Paste the whole Lights link the relay printed, including the # part.', 'warn'); return; }
    $('#li-link').removeAttribute('aria-invalid');
    const prev = link; link = p;   // keep the old link unless the new one works
    try { const d = await call('/lights'); lights = d.lights || []; lastOk = Date.now(); failing = false; }
    catch (e) { link = prev; PH.toast(e.message, 'warn'); return; }
    save('link', link); save('cache', lights); note('');
    $('#li-link').value = ''; PH.toast('Lights connected.'); PH.go('/'); render();
  });
  $('#li-link').addEventListener('keydown', e => { if (e.key === 'Enter') $('#li-save').click(); });
  $('#li-rescan').addEventListener('click', () => { if (ready()) { PH.toast('Scanning…'); refresh(true); } else PH.go('/settings/relay'); });
  $('#li-forget').addEventListener('click', async () => {
    if (!await PH.confirm('Forget the lights relay on this phone? You can paste the link again any time.', { title: 'Forget relay', ok: 'Forget', danger: true })) return;
    link = null; lights = []; save('link', null); save('cache', []); PH.toast('Relay forgotten.', 'warn'); render();
  });


  /* ---------- Party mode: every light flashes together until stopped ---------- */
  // Each beat sends one request per light at the same time and waits for them all, so the
  // pace never outruns what the bulbs and the relay can do. Lights are put back afterwards.
  const BEAT = { slow: 1200, medium: 600, fast: 250 };
  const STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14"/></svg>';
  const GO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
  let party = null;   // { snap, beat, fails }
  const partyOn = () => !!party;
  const send = (id, body) => call('/lights/' + encodeURIComponent(id), body);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let wake = null;
  async function startParty() {
    if (!ready()) { PH.go('/settings/relay'); return; }
    const targets = lights.filter(l => l.online);
    if (!targets.length) { PH.toast('No lights are responding right now.', 'warn'); return; }
    party = { snap: targets.map(l => ({ ...l, hsv: l.hsv && [...l.hsv] })), beat: 0, fails: 0 };
    clearInterval(pollT); pollT = null;
    try { wake = await navigator.wakeLock?.request('screen'); } catch {}
    renderParty();
    const run = party;
    while (party === run) {
      const t0 = Date.now(), mode = PH.store.get('partyMode'), k = run.beat++;
      const on = k % 2 === 0, hue = (k * 137) % 360;
      run.pending = Promise.allSettled(run.snap.map((l, i) => {
        const colour = l.hsv && (mode === 'color' || (mode === 'both' && on));
        if (colour) return send(l.id, { hsv: [(hue + i * 60) % 360, 100, 100], on: true });
        return send(l.id, { on: mode === 'color' ? true : on });
      }));
      const res = await run.pending;
      if (party !== run) break;
      run.fails = res.every(r => r.status === 'rejected') ? run.fails + 1 : 0;
      if (run.fails >= 3) { PH.toast(res[0].reason?.message || 'Lost the relay.', 'warn'); await stopParty(); return; }
      await sleep(Math.max(0, (BEAT[PH.store.get('partySpeed')] || 600) - (Date.now() - t0)));
    }
  }
  async function stopParty() {
    const run = party; if (!run) return;
    party = null; renderParty();
    try { await wake?.release(); } catch {} wake = null;
    // let the last flash land first so it can't undo the restore, but never hold Stop up for long
    await Promise.race([run.pending, sleep(1500)]);
    // put every light back the way it was
    await Promise.allSettled(run.snap.map(l => {
      if (!l.on) return send(l.id, { on: false });
      const body = { on: true };
      if (l.hsv && !l.temp) body.hsv = l.hsv; else if (l.temp) body.temp = l.temp;
      if (l.brightness != null) body.brightness = l.brightness;
      return send(l.id, body);
    }));
    PH.toast('Party over. Lights restored.');
    sync();
  }
  function renderParty() {
    const on = partyOn();
    $('#pa-stage').classList.toggle('is-on', on);
    $('#pa-state').textContent = on ? 'Party on' : 'Ready';
    $('#pa-go').textContent = on ? 'Stop party' : 'Start party';
    $('#pa-go').className = 'btn btn-block ' + (on ? 'btn-danger' : 'btn-primary');
    const k = $('#k-party'); k.innerHTML = on ? STOP_SVG : GO_SVG; k.setAttribute('aria-label', on ? 'Stop party' : 'Start party'); k.setAttribute('aria-pressed', String(on));
    const m = PH.store.get('partyMode');
    $('#pa-hint').textContent = m === 'color' ? 'Colour bulbs jump between bright colours.' : m === 'both' ? 'Lights flash and colour bulbs change colour on every flash.' : 'Every light flashes on and off together.';
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-pa-toggle]')) partyOn() ? stopParty() : startParty(); });
  PH.on('partyMode', renderParty);
  // Party mode lives on its page: leaving it (Back, Home, the menu) ends the party
  PH.on('route', r => { if (party && r !== '/party') stopParty(); });
  renderParty();
  // Phosphor OS awaits this before removing the app's frame, so a running party is stopped and restored
  window.osBeforeClose = () => stopParty();

  // Poll only while the app is on screen
  let pollT = null;
  function sync() {
    clearInterval(pollT); pollT = null;
    render();
    if (party) { if (document.hidden) stopParty(); return; }
    if (document.hidden || !ready()) return;
    refresh(); pollT = setInterval(() => { if (!dragging) refresh(); }, 6000);
  }
  PH.on('route', render);
  document.addEventListener('visibilitychange', sync);
  addEventListener('online', sync);
  addEventListener('pageshow', e => { if (e.persisted) sync(); });
  render(); setTimeout(sync, 0);
})();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
