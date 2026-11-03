(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var socket = io();

  var session = null;
  try { session = JSON.parse(localStorage.getItem('dh_session') || 'null'); } catch (e) {}
  var state = null;
  var offset = 0; // server time - local time
  var myPos = null;
  var heading = null;
  var watchId = null;
  var lastSent = 0;
  var map = null, layer = null, zoneCircle = null, fitted = false;
  var map2 = null;
  var wake = null;

  /* ---------- screens ---------- */
  function show(id) {
    ['home', 'lobby', 'game', 'end'].forEach(function (n) {
      $('#screen-' + n).classList.toggle('on', n === id);
    });
    if (id === 'game' && map) setTimeout(function () { map.invalidateSize(); }, 50);
  }
  function save(s) {
    session = s;
    if (s) localStorage.setItem('dh_session', JSON.stringify(s));
    else localStorage.removeItem('dh_session');
  }
  var nameInput = $('#name');
  nameInput.value = localStorage.getItem('dh_name') || '';

  /* ---------- geolocation ---------- */
  function startGps() {
    if (watchId !== null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(
      function (p) {
        myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
        var now = Date.now();
        if (now - lastSent > 2000) {
          lastSent = now;
          socket.emit('loc', myPos);
        }
        setGps(true, myPos.acc);
        if (state && (state.phase === 'headstart' || state.phase === 'hunt')) drawMap();
      },
      function (err) { setGps(false, err.message); },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
    try {
      if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wake = w; }).catch(function () {});
    } catch (e) {}
  }
  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (wake) { try { wake.release(); } catch (e) {} wake = null; }
  }
  function setGps(ok, info) {
    var el = $('#gpsStatus');
    el.className = 'gps ' + (ok ? 'ok' : 'no');
    el.textContent = ok ? 'GPS ready (±' + Math.round(info) + ' m)' : 'GPS problem: ' + info + ' — allow location access.';
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && session && wake === null && navigator.wakeLock) {
      navigator.wakeLock.request('screen').then(function (w) { wake = w; }).catch(function () {});
    }
  });

  /* ---------- compass ---------- */
  function onOrient(e) {
    var h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha !== null) h = 360 - e.alpha;
    if (h !== null) { heading = h; updateCompass(); }
  }
  function enableCompass() {
    var start = function () {
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      $('#btnCompass').style.display = 'none';
    };
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(function (r) { if (r === 'granted') start(); }).catch(function () {});
    } else start();
  }
  $('#btnCompass').onclick = enableCompass;

  function toRad(d) { return d * Math.PI / 180; }
  function dist(a, b) {
    var R = 6371000, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    var x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function bearing(a, b) {
    var y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    var x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km'; }
  function fmtTime(ms) {
    if (ms === null || ms === undefined) return '--:--';
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function nearestTarget() {
    if (!state || state.you.side !== 'hunter' || !myPos) return null;
    var targets = [];
    if (state.ping) targets = targets.concat(state.ping.shadows);
    // live-revealed shadows (outside the zone) override the stale ping for the same player
    (state.revealed || []).forEach(function (r) {
      targets = targets.filter(function (t) { return t.id !== r.id; });
      targets.push(r);
    });
    var best = null, bd = Infinity;
    targets.forEach(function (t) {
      var d = dist(myPos, t);
      if (d < bd) { bd = d; best = t; }
    });
    return best ? { t: best, d: bd } : null;
  }
  function updateCompass() {
    var box = $('#compass');
    var n = nearestTarget();
    if (!n) { box.style.display = state && state.you.side === 'hunter' && state.phase === 'hunt' ? 'flex' : 'none';
      $('#cmpDist').textContent = '--'; return; }
    box.style.display = 'flex';
    var b = bearing(myPos, n.t) - (heading || 0);
    $('#arrow').style.transform = 'rotate(' + b + 'deg)';
    $('#cmpDist').textContent = fmtDist(n.d);
    $('#cmpLbl').textContent = heading === null ? 'Nearest Shadow (north is up)' : 'Nearest Shadow';
    $('#btnCompass').style.display = heading === null ? 'inline-flex' : 'none';
  }

  /* ---------- map ---------- */
  function mkIcon(cls) {
    return L.divIcon({ className: '', html: '<div class="pm ' + cls + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  }
  function initMap() {
    if (map) return;
    map = L.map('map', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    map.setView([0, 0], 2);
  }
  function drawMap() {
    if (!map || !state || !state.zone) return;
    layer.clearLayers();
    var z = state.zone;
    var ring = L.circle([z.lat, z.lng], { radius: z.radius, color: '#ff4d6d', weight: 3, dashArray: '8 8', fillColor: '#ff4d6d', fillOpacity: 0.05 });
    ring.addTo(layer);
    if (!fitted) { map.fitBounds(ring.getBounds()); fitted = true; }

    (state.mates || []).forEach(function (m) {
      if (m.caught) return;
      L.marker([m.lat, m.lng], { icon: mkIcon(state.you.side) }).bindTooltip(m.name).addTo(layer);
    });
    if (state.you.side === 'hunter') {
      if (state.ping) {
        state.ping.shadows.forEach(function (s) {
          L.marker([s.lat, s.lng], { icon: mkIcon('ping') }).bindTooltip(s.name + ' (last ping)').addTo(layer);
        });
      }
      (state.revealed || []).forEach(function (s) {
        L.marker([s.lat, s.lng], { icon: mkIcon('rev') }).bindTooltip(s.name + ' (outside zone!)').addTo(layer);
      });
    }
    if (myPos) {
      L.marker([myPos.lat, myPos.lng], { icon: mkIcon('me'), zIndexOffset: 1000 }).addTo(layer);
      if (myPos.acc && myPos.acc < 200) L.circle([myPos.lat, myPos.lng], { radius: myPos.acc, weight: 1, color: '#3aa0ff', fillOpacity: 0.08 }).addTo(layer);
    }
  }

  /* ---------- rendering ---------- */
  function renderLobby(s) {
    $('#lobbyCode').textContent = s.code;
    var ul = $('#plist');
    ul.innerHTML = '';
    s.players.forEach(function (p) {
      var li = document.createElement('li');
      var left = document.createElement('span');
      left.textContent = p.name + (p.host ? ' (host)' : '') + (p.id === s.you.id ? ' — you' : '');
      if (!p.connected) left.style.opacity = '.5';
      var b = document.createElement('span');
      b.className = 'badge ' + p.side;
      b.textContent = p.side;
      li.appendChild(left); li.appendChild(b);
      ul.appendChild(li);
    });
    $('#sideHunter').style.outline = s.you.side === 'hunter' ? '2px solid #fff' : 'none';
    $('#sideShadow').style.outline = s.you.side === 'shadow' ? '2px solid #fff' : 'none';
    $('#hostBox').style.display = s.you.host ? 'block' : 'none';
    $('#waitBox').style.display = s.you.host ? 'none' : 'block';
    $('#waitBox').textContent = 'Zone radius: ' + s.baseRadius + ' m. Waiting for the host to start…';
    var inp = $('#radiusInput');
    inp.min = s.cfg.minRadius; inp.max = s.cfg.maxRadius;
    if (document.activeElement !== inp) inp.value = s.baseRadius;
    var seg = $('#radiusSeg');
    seg.innerHTML = '';
    [150, 250, 400].forEach(function (r) {
      var b = document.createElement('button');
      b.className = 'btn ghost sm' + (r === s.baseRadius ? ' on' : '');
      b.textContent = r + ' m';
      b.onclick = function () { socket.emit('setRadius', r); };
      seg.appendChild(b);
    });
  }

  function applyRadius() {
    var v = parseInt($('#radiusInput').value, 10);
    if (!isFinite(v)) return;
    var min = state ? state.cfg.minRadius : 50, max = state ? state.cfg.maxRadius : 400;
    v = Math.min(max, Math.max(min, v));
    $('#radiusInput').value = v;
    socket.emit('setRadius', v);
  }
  $('#btnRadiusSet').onclick = applyRadius;
  $('#radiusInput').addEventListener('change', applyRadius);

  function renderGame(s) {
    initMap();
    var side = s.you.side;
    $('#roleTxt').textContent = side === 'hunter' ? 'HUNTER' : (s.you.caught ? 'CAUGHT' : 'SHADOW');
    $('#chipRole').className = 'chip role ' + side;
    $('#zoneTxt').textContent = s.zone ? fmtDist(s.zone.radius) : '-';
    $('#chipPing').style.display = s.phase === 'hunt' ? 'block' : 'none';
    $('#chipZone').style.display = s.phase === 'hunt' ? 'block' : 'none';
    $('#btnTag').style.display = side === 'shadow' && !s.you.caught && s.phase === 'hunt' ? 'block' : 'none';
    $('#compass').style.display = side === 'hunter' && s.phase === 'hunt' ? 'flex' : 'none';
    updateCompass();
    drawMap();
    tickHud();
  }

  function tickHud() {
    if (!state) return;
    var now = Date.now() + offset;
    var t = state.times;
    var banner = $('#banner');
    banner.className = 'banner';
    if (state.phase === 'headstart') {
      $('#t1l').textContent = 'Hunters released in';
      $('#t1').textContent = fmtTime(t.huntStartAt - now);
      banner.className = 'banner info';
      banner.textContent = state.you.side === 'hunter' ? 'Stay put! Shadows are running.' : 'Run and hide! Hunters are frozen.';
    } else if (state.phase === 'hunt') {
      $('#t1l').textContent = 'Time left';
      $('#t1').textContent = fmtTime(t.endAt - now);
      $('#t2').textContent = fmtTime(t.nextPingAt - now);
      $('#t3').textContent = fmtTime(t.nextShrinkAt - now);
      if (state.you.caught) {
        banner.className = 'banner info';
        banner.textContent = 'You were caught. Watch the rest of the match.';
      } else if (myPos && state.zone && dist(myPos, state.zone) > state.zone.radius) {
        banner.className = 'banner warn';
        banner.textContent = state.you.side === 'shadow'
          ? 'Outside the zone! Hunters can see you.' : 'You are outside the zone. Head back in.';
      }
    }
  }
  setInterval(tickHud, 250);

  function renderEnd(s) {
    var mine = (s.winner === 'hunters') === (s.you.side === 'hunter');
    $('#endTitle').textContent = s.winner === 'hunters' ? 'Hunters win' : 'Shadows win';
    $('#endTitle').style.color = s.winner === 'hunters' ? 'var(--hunter)' : 'var(--shadow)';
    $('#endReason').textContent = (mine ? 'Nice one. ' : 'Better luck next time. ') + (s.endReason || '');
    if (!map2) {
      map2 = L.map('map2', { zoomControl: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map2);
    }
    map2.eachLayer(function (l) { if (!l._url) map2.removeLayer(l); });
    var pts = [];
    (s.final || []).forEach(function (p) {
      pts.push([p.lat, p.lng]);
      L.marker([p.lat, p.lng], { icon: mkIcon(p.side) }).bindTooltip(p.name + (p.caught ? ' (caught)' : '')).addTo(map2);
    });
    if (s.zone) L.circle([s.zone.lat, s.zone.lng], { radius: s.zone.radius, color: '#ff4d6d', dashArray: '8 8', fillOpacity: 0.04 }).addTo(map2);
    if (pts.length) map2.fitBounds(pts, { padding: [30, 30], maxZoom: 17 }); else map2.setView([0, 0], 2);
    setTimeout(function () { map2.invalidateSize(); }, 100);
  }

  var lastPhase = null;
  socket.on('state', function (s) {
    state = s;
    offset = s.now - Date.now();
    if (s.phase === 'lobby') { show('lobby'); renderLobby(s); }
    else if (s.phase === 'headstart' || s.phase === 'hunt') {
      if (lastPhase !== s.phase || !$('#screen-game').classList.contains('on')) show('game');
      renderGame(s);
    } else if (s.phase === 'ended') {
      if (lastPhase !== 'ended') { show('end'); stopGps(); renderEnd(s); }
    }
    lastPhase = s.phase;
  });

  /* ---------- actions ---------- */
  function afterJoin(res, name) {
    if (!res.ok) { $('#homeErr').textContent = res.error || 'Something went wrong.'; return; }
    localStorage.setItem('dh_name', name);
    save({ code: res.code, playerId: res.playerId });
    startGps();
  }
  $('#btnCreate').onclick = function () {
    var name = nameInput.value.trim();
    $('#homeErr').textContent = '';
    socket.emit('create', { name: name }, function (res) { afterJoin(res, name); });
  };
  $('#btnJoin').onclick = function () {
    var name = nameInput.value.trim();
    $('#homeErr').textContent = '';
    socket.emit('join', { name: name, code: $('#code').value }, function (res) { afterJoin(res, name); });
  };
  $('#sideHunter').onclick = function () { socket.emit('setSide', 'hunter'); };
  $('#sideShadow').onclick = function () { socket.emit('setSide', 'shadow'); };
  $('#btnStart').onclick = function () {
    $('#lobbyErr').textContent = '';
    applyRadius(); // make sure a typed-but-not-confirmed value is used
    if (myPos) socket.emit('loc', myPos);
    socket.emit('start', {}, function (res) { if (!res.ok) $('#lobbyErr').textContent = res.error; });
  };
  $('#btnTag').onclick = function () {
    if (confirm('Confirm: you were tagged by a Hunter?')) socket.emit('tagged');
  };
  $('#btnLeave').onclick = function () {
    socket.emit('leave');
    save(null); stopGps(); state = null; lastPhase = null; show('home');
  };
  $('#btnAgain').onclick = function () {
    socket.emit('leave');
    save(null); stopGps(); state = null; lastPhase = null; fitted = false; show('home');
  };
  $('#btnShare').onclick = function () {
    var text = 'Join my DuskHunt match! Code: ' + state.code + ' — ' + location.origin + '/play';
    if (navigator.share) navigator.share({ title: 'DuskHunt', text: text }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { $('#lobbyErr').textContent = 'Invite copied.'; });
  };

  /* ---------- resume after reload / reconnect ---------- */
  function tryResume() {
    if (!session) return;
    socket.emit('resume', session, function (res) {
      if (res && res.ok) startGps();
      else { save(null); show('home'); }
    });
  }
  socket.on('connect', tryResume);
})();
