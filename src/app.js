/* Kasa Lights. Talks to the lights relay (kasa_bridge.py in bgriffie/phosphor-os/bridge) running on a
   computer at home, reached over HTTPS through Tailscale. The relay talks to the Kasa bulbs.
   Same relay, API and link as the Lights app in Phosphor OS. */
PH.init({});
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

  // Poll only while the app is on screen
  let pollT = null;
  function sync() {
    clearInterval(pollT); pollT = null;
    render();
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
