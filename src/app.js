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
    if (!r.ok) { const e = new Error(d.error || 'Relay error ' + r.status); e.status = r.status; throw e; }
    return d;
  }

  const note = t => { $('#li-note').textContent = t || ''; $('#li-note').hidden = !t; };
  async function refresh(scan) {
    const pp = pollParty();
    try {
      const d = await call(scan ? '/lights/rescan' : '/lights', scan ? {} : undefined);
      lights = d.lights || []; save('cache', lights); lastOk = Date.now(); failing = false; note('');
      if (scan) PH.toast(lights.length + ' light' + (lights.length === 1 ? '' : 's') + ' found.');
    } catch (e) { failing = true; note(e.message); if (scan) PH.toast(e.message, 'warn'); }
    await pp;
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
  const pct = l => !l.online ? 'No reply' : !l.on ? 'Off' : l.brightness != null ? l.brightness + '%' : 'On';
  const MORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6"/></svg>';
  function tile(l) {
    const c = document.createElement('div');
    c.className = 'tl' + (l.on && l.online ? ' is-on' : '') + (l.online ? '' : ' is-offline'); c.dataset.id = l.id;
    c.innerHTML = `<button class="tl-main" data-li-tog><span class="tl-name"></span><span class="tl-sub"><span class="dot"></span><span class="tl-pct"></span></span></button>`;
    const m = c.firstChild; m.disabled = !l.online;
    m.setAttribute('aria-label', `${l.name}: ${pct(l)}. Tap to turn ${l.on ? 'off' : 'on'}`);
    c.querySelector('.tl-name').textContent = l.name;
    c.querySelector('.tl-pct').textContent = pct(l);
    c.querySelector('.dot').style.background = tint(l);
    if (l.kind !== 'plug' && (l.brightness != null || l.hsv || l.tempRange)) {
      const o = document.createElement('button'); o.className = 'tl-more'; o.dataset.liOpen = ''; o.innerHTML = MORE;
      o.setAttribute('aria-label', l.name + ': brightness and colour'); c.appendChild(o);
    }
    return c;
  }
  const near = (a, b, d) => Math.abs(a - b) < d;
  const isWarm = l => l.on && l.tempRange && l.temp && near(l.temp, Math.max(l.tempRange[0], 2700), 200);
  let dragging = false;
  function render() {
    $('#li-off').hidden = ready(); $('#li-on').hidden = !ready();
    const live = lights.filter(l => l.online), nOn = live.filter(l => l.on).length;
    if (!dragging) {
      const box = $('#li-list'); box.textContent = '';
      box.style.setProperty('--rows', Math.max(1, Math.ceil(lights.length / 2)));
      if (ready() && !lights.length) box.innerHTML = `<p class="menu-note">${failing ? 'No lights to show yet.' : lastOk ? 'The relay didn\'t find any Kasa lights. Make sure the computer is on the same Wi-Fi, then Rescan in Settings.' : 'Looking for lights…'}</p>`;
      lights.forEach(l => box.appendChild(tile(l)));
      box.classList.toggle('busy', partyOn());
      renderOne();
    }
    // status line
    const led = $('#li-led');
    led.className = 'led' + (!ready() ? '' : failing ? ' err' : lastOk ? ' on' : ' wait');
    $('#li-sum').textContent = failing ? 'Can\'t reach the relay' : !lastOk && !lights.length ? 'Connecting…'
      : !lights.length ? 'No lights found' : nOn ? `${nOn} of ${lights.length} on` : `All ${lights.length} off`;
    const pw = $('#li-pow'); pw.setAttribute('aria-pressed', String(nOn > 0)); pw.setAttribute('aria-label', nOn ? 'All off' : 'All on'); pw.disabled = !live.length;
    // channels: light up the one that matches what the lights are doing
    const party = partyOn();
    $('#ch-on').classList.toggle('cur', !party && live.length > 0 && nOn === live.length && !live.every(isWarm));
    $('#ch-off').classList.toggle('cur', !party && live.length > 0 && nOn === 0);
    const warmable = live.filter(l => l.tempRange);
    $('#ch-warm').classList.toggle('cur', !party && warmable.length > 0 && warmable.every(isWarm));
    $('#ch-party').classList.toggle('cur', party);
    $('#ch-on').disabled = $('#ch-off').disabled = party || !live.length;
    $('#ch-warm').disabled = party || !warmable.length;
    // settings rows
    $('#li-status').textContent = !ready() ? 'Not set up' : failing ? 'Can\'t reach' : lastOk ? 'Connected' : 'Connecting…';
    $('#li-status').className = 'mi-value' + (ready() && !failing && lastOk ? ' t-accent' : '');
    $('#li-forget').hidden = !ready();
    $('#li-count').textContent = ready() ? String(lights.length) : '—';
    const pk = $('#k-power'), one = route() === '/light' && lights.find(x => x.id === openId);
    pk.disabled = !ready() || party || (one ? !one.online : !live.length);
    pk.setAttribute('aria-pressed', String(one ? !!one.on : nOn > 0));
    pk.setAttribute('aria-label', one ? (one.on ? 'Turn off' : 'Turn on') : nOn ? 'All off' : 'All on');
  }
  const SWATCH = [['Green', 125, 85], ['Cyan', 185, 90], ['Blue', 225, 95], ['Purple', 275, 85], ['Pink', 320, 75], ['Red', 0, 95], ['Orange', 28, 95], ['Gold', 45, 85]];
  const WHITES = [['Warm', 2700], ['Soft', 3500], ['Neutral', 4500], ['Day', 6500]];
  function renderOne() {
    const l = lights.find(x => x.id === openId);
    $('#one-gone').hidden = !!l;
    ['#one-dim', '#one-col', '#one-wh', '#one-pow'].forEach(k => { $(k).hidden = !l; });
    if (!l) { $('#one-name').textContent = 'Light'; $('#one-sub').textContent = ''; return; }
    $('#li-one').dataset.id = l.id;
    $('#one-name').textContent = l.name;
    $('#one-sub').textContent = pct(l) + (l.model ? ' · ' + l.model : '');
    const d = $('#one-dot'); d.style.background = tint(l); d.classList.toggle('is-on', !!(l.on && l.online));
    const pw = $('#one-pow'); pw.setAttribute('aria-pressed', String(!!l.on)); pw.setAttribute('aria-label', l.on ? 'Turn off' : 'Turn on'); pw.disabled = !l.online;
    $('#one-dim').hidden = l.brightness == null;
    if (l.brightness != null) { const r = $('#one-range'); r.value = l.brightness; r.disabled = !l.online; $('#one-pct').textContent = l.brightness + '%'; }
    $('#one-col').hidden = !l.hsv;
    if (l.hsv) {
      const g = $('#one-sw'); g.textContent = '';
      SWATCH.forEach(([n, h, s]) => { const b = document.createElement('button'); b.className = 'li-sw'; b.dataset.liHsv = h + ',' + s; b.setAttribute('aria-label', n);
        b.style.background = `hsl(${h} ${s}% 55%)`; if (!l.temp && near(l.hsv[0], h, 6) && l.on) b.classList.add('is-sel'); b.disabled = !l.online; g.appendChild(b); });
    }
    $('#one-wh').hidden = !l.tempRange;
    if (l.tempRange) {
      const g = $('#one-whites'); g.textContent = '';
      WHITES.forEach(([n, k]) => { const kk = Math.max(l.tempRange[0], Math.min(l.tempRange[1], k)); const b = document.createElement('button'); b.className = 'rm-b'; b.textContent = n;
        b.dataset.liTemp = kk; if (l.temp && near(l.temp, kk, 200) && l.on) b.classList.add('is-sel'); b.disabled = !l.online; g.appendChild(b); });
    }
  }
  // Warm: every white-capable light to warm white, the rest on
  async function warm() {
    const live = lights.filter(l => l.online); if (!live.length) return;
    live.forEach(l => { l.on = true; if (l.tempRange) { l.temp = Math.max(l.tempRange[0], 2700); } }); render();
    const res = await Promise.allSettled(live.map(l => call('/lights/' + encodeURIComponent(l.id), l.tempRange ? { temp: l.temp, on: true } : { on: true })));
    res.forEach(r => { if (r.status === 'fulfilled') merge(r.value); });
    const bad = res.find(r => r.status === 'rejected'); if (bad) { note(bad.reason.message); PH.toast(bad.reason.message, 'warn'); } else note('');
    render();
  }

  /* ---------- Wiring ---------- */
  const idOf = el => el.dataset.id || el.closest('[data-id]')?.dataset.id;
  $('#one-range').addEventListener('input', e => { dragging = true; $('#one-pct').textContent = e.target.value + '%'; });
  $('#one-range').addEventListener('change', e => { dragging = false; set(idOf(e.target), { brightness: +e.target.value }); });
  $('#one-pow').addEventListener('click', () => { const l = lights.find(x => x.id === openId); if (l) set(l.id, { on: !l.on }); });
  $('#li-pow').addEventListener('click', () => all(!anyOn()));
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-li-tog]');
    if (t) { const l = lights.find(x => x.id === idOf(t)); if (l && !partyOn()) set(l.id, { on: !l.on }); return; }
    const o = e.target.closest('[data-li-open]');
    if (o) { openId = idOf(o); save('open', openId); renderOne(); PH.go('/light'); return; }
    const sw = e.target.closest('[data-li-hsv]');
    if (sw) { const [h, s] = sw.dataset.liHsv.split(',').map(Number); const l = lights.find(x => x.id === idOf(sw)); set(idOf(sw), { hsv: [h, s, (l && l.brightness) || 80] }); return; }
    const w = e.target.closest('[data-li-temp]');
    if (w) { set(idOf(w), { temp: +w.dataset.liTemp }); return; }
    if (e.target.closest('[data-li-warm]')) { warm(); return; }
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
  // The relay runs the party (party.py next to kasa_bridge.py), so it keeps going after this app is
  // closed, and Phosphor OS and Home Map see and stop the same party. An older relay without it
  // falls back to the loop below, which only runs while this app is open.
  let relayParty = null, relayHas = null, adopting = false;   // relayHas: null = not asked yet
  async function pollParty() {
    if (relayHas === false || !ready()) return;
    try { adopt(await call('/party')); relayHas = true; }
    catch (e) { if (e.status === 404 || e.status === 405) relayHas = false; }
  }
  function adopt(d) {
    relayParty = d;
    if (d && d.on) {   // show the mode and speed the party is really using
      adopting = true;
      if (d.mode && PH.store.get('partyMode') !== d.mode) PH.store.set('partyMode', d.mode);
      if (d.speed && PH.store.get('partySpeed') !== d.speed) PH.store.set('partySpeed', d.speed);
      adopting = false;
    }
    renderParty();
  }
  async function startParty() {
    if (!ready()) { PH.go('/settings/relay'); return; }
    if (relayHas === null) await pollParty();
    if (!relayHas) return startLocal();
    try { adopt(await call('/party', { on: true, mode: PH.store.get('partyMode'), speed: PH.store.get('partySpeed') })); PH.toast('Party on. It keeps going until you stop it.'); }
    catch (e) { PH.toast(e.message, 'warn'); }
  }
  async function stopParty() {
    if (party) return stopLocal();
    if (!relayParty || !relayParty.on) return;
    try { adopt(await call('/party', { on: false })); PH.toast('Party over. Lights restored.'); }
    catch (e) { PH.toast(e.message, 'warn'); }
    refresh();
  }
  function partyChanged() {
    if (!adopting && relayParty && relayParty.on)
      call('/party', { mode: PH.store.get('partyMode'), speed: PH.store.get('partySpeed') }).then(adopt).catch(() => {});
    renderParty();
  }

  // Fallback for an older relay: each beat sends one request per light at the same time and waits for them all, so the
  // pace never outruns what the bulbs and the relay can do. Lights are put back afterwards.
  const BEAT = { slow: 1200, medium: 600, fast: 250 };
  const STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14"/></svg>';
  const GO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
  let party = null;   // the local loop: { snap, beat, fails }
  const partyOn = () => !!party || !!(relayParty && relayParty.on);
  const send = (id, body) => call('/lights/' + encodeURIComponent(id), body);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let wake = null;
  async function startLocal() {
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
      if (run.fails >= 3) { PH.toast(res[0].reason?.message || 'Lost the relay.', 'warn'); await stopLocal(); return; }
      await sleep(Math.max(0, (BEAT[PH.store.get('partySpeed')] || 600) - (Date.now() - t0)));
    }
  }
  async function stopLocal() {
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
  const MODE_T = { strobe: 'Strobe', color: 'Colour', both: 'Strobe + colour' }, SPEED_T = { slow: 'Slow', medium: 'Medium', fast: 'Fast' };
  function renderParty() {
    const on = partyOn(), m = PH.store.get('partyMode');
    const go = $('#pa-go'); go.classList.toggle('is-on', on); go.classList.toggle('pa-live', on);
    go.innerHTML = (on ? STOP_SVG : GO_SVG) + `<span>${on ? 'Stop party' : 'Start party'}</span>`;
    $('#pa-led').className = 'led' + (on ? ' on' : '');
    $('#pa-hint').textContent = on ? (party ? 'Party on while this app is open' : 'Party on until you stop it') : m === 'color' ? 'Colour bulbs jump between colours' : m === 'both' ? 'Flash and change colour' : 'Every light flashes together';
    $('#pa-line').hidden = !on;
    $('#pa-line-s').textContent = MODE_T[m] + ' · ' + SPEED_T[PH.store.get('partySpeed')];
    const k = $('#k-party'); k.innerHTML = on ? STOP_SVG : GO_SVG; k.setAttribute('aria-label', on ? 'Stop party' : 'Start party'); k.setAttribute('aria-pressed', String(on));
    render();
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-pa-toggle]')) partyOn() ? stopParty() : startParty(); });
  PH.on('partyMode', partyChanged); PH.on('partySpeed', partyChanged);
  // The fallback loop can't outlive this page, so leaving the Lights and Party pages ends it
  PH.on('route', r => { if (party && r !== '/party' && r !== '/') stopLocal(); });
  renderParty();
  // Phosphor OS awaits this before removing the app's frame. A relay party keeps going; only the fallback loop stops.
  window.osBeforeClose = () => stopLocal();

  // Poll only while the app is on screen
  let pollT = null;
  function sync() {
    clearInterval(pollT); pollT = null;
    render();
    if (party) { if (document.hidden) stopLocal(); return; }
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
