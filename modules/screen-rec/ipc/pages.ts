/**
 * Self-contained HTML pages for ScreenRec's shell helper windows
 * (ctx.createHelperWindow). Plain inline JS/CSS — they talk to ipc.ts over
 * `screen-rec:*` channels through the normal window.wicked bridge.
 *
 *  - recorder:  hidden worker. Desktop capture (+ mic, + optional computer
 *               sound mixed in WebAudio) → MediaRecorder → 1 s chunks to main.
 *  - overlay:   one per monitor. Screen picker ("click or press 2"), then the
 *               armed view showing exactly what will be recorded ("press R"),
 *               then the optional countdown.
 *  - indicator: small REC pill at the top of the recorded screen; created
 *               with excludeFromCapture so it never appears in the video.
 */

const HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; media-src blob: mediastream:">`

export function recorderHtml(): string {
  return `${HEAD}<title>ScreenRec recorder</title></head><body><script>
(() => {
  'use strict'
  const api = window.wicked
  const P = 'screen-rec:'
  let cur = null
  let primed = false
  const msg = (e) => (e && (e.message || e.name)) ? String(e.message || e.name) : String(e)
  const ev = (type, data) => api.invoke(P + 'rec-event', Object.assign({ type }, data || {})).catch(() => {})
  const friendly = (e, what) => {
    const n = e && e.name
    if (n === 'NotAllowedError' || n === 'SecurityError') return what + ' was blocked — check Windows Settings → Privacy & security.'
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return what + ' was not found — is it connected?'
    if (n === 'NotReadableError' || n === 'AbortError') return what + ' could not be opened — another app may be using it exclusively.'
    return what + ': ' + msg(e)
  }
  const pickMime = (audio) => {
    const list = audio
      ? ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    return list.find((t) => { try { return MediaRecorder.isTypeSupported(t) } catch (e) { return false } }) || ''
  }
  async function prime() {
    if (primed) return
    primed = true
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()) } catch (e) { /* labels may stay hidden */ }
  }
  async function resolveMic(mic, warnings) {
    if (!mic.deviceId || mic.deviceId === 'default') return 'default'
    await prime()
    let devs = []
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput') } catch (e) { /* none */ }
    if (devs.some((d) => d.deviceId === mic.deviceId)) return mic.deviceId
    const byLabel = devs.find((d) => d.label && mic.label && d.label === mic.label)
    if (byLabel) return byLabel.deviceId
    warnings.push('Microphone "' + (mic.label || 'selected') + '" is not connected — using the Windows default microphone.')
    return 'default'
  }
  function cleanup(c) {
    c.timers.forEach((t) => clearInterval(t))
    c.owned.forEach((s) => s.getTracks().forEach((t) => { try { t.stop() } catch (e) {} }))
    if (c.ac) c.ac.close().catch(() => {})
    if (cur === c) cur = null
  }
  async function start(o) {
    if (cur) { ev('error', { clipId: o.clipId, phase: 'start', message: 'A recording is already running' }); return }
    const warnings = []
    const owned = []
    let c = null
    try {
      const video = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: o.sourceId, maxWidth: o.width, maxHeight: o.height, maxFrameRate: o.fps } }
      let screen = null
      if (o.systemAudio) {
        try { screen = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video }) }
        catch (e) { warnings.push('Computer sound could not be captured (' + msg(e) + ') — recording without it.') }
      }
      if (!screen) {
        try { screen = await navigator.mediaDevices.getUserMedia({ audio: false, video }) }
        catch (e) { throw new Error(friendly(e, 'Screen capture')) }
      }
      owned.push(screen)
      const vTrack = screen.getVideoTracks()[0]
      if (!vTrack) throw new Error('Screen capture returned no video')
      let mic = null
      if (o.mic) {
        try {
          const id = await resolveMic(o.mic, warnings)
          const base = { echoCancellation: false, noiseSuppression: !!o.noiseSuppression, autoGainControl: false }
          try { mic = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: id } }, base) }) }
          catch (e1) { if (id === 'default') throw e1; warnings.push('Could not open the chosen microphone — using the Windows default.'); mic = await navigator.mediaDevices.getUserMedia({ audio: base }) }
          owned.push(mic)
        } catch (e) { warnings.push(friendly(e, 'Microphone') + ' Recording without voice.'); mic = null }
      }
      const sys = screen.getAudioTracks()
      let ac = null, analyser = null, audio = null
      if (mic || sys.length) {
        ac = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' })
        try { await ac.resume() } catch (e) {}
        const dest = ac.createMediaStreamDestination()
        analyser = ac.createAnalyser()
        analyser.fftSize = 2048
        if (mic) {
          const src = ac.createMediaStreamSource(mic)
          const g = ac.createGain()
          g.gain.value = Math.pow(10, (Number(o.micGainDb) || 0) / 20)
          src.connect(g); g.connect(dest); g.connect(analyser)
        }
        if (sys.length) {
          const s2 = ac.createMediaStreamSource(new MediaStream(sys))
          s2.connect(dest)
          if (!mic) s2.connect(analyser)
        }
        audio = dest.stream.getAudioTracks()[0] || null
      }
      const mimeType = pickMime(!!audio)
      const stream = new MediaStream(audio ? [vTrack, audio] : [vTrack])
      const opts = { videoBitsPerSecond: o.videoBitsPerSecond, audioBitsPerSecond: 192000 }
      if (mimeType) opts.mimeType = mimeType
      const rec = new MediaRecorder(stream, opts)
      c = { clipId: o.clipId, rec, owned, ac, seq: 0, q: Promise.resolve(), t0: 0, timers: [], stopping: false }
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return
        const seq = c.seq++
        const blob = e.data
        c.q = c.q.then(async () => {
          const data = new Uint8Array(await blob.arrayBuffer())
          const r = await api.invoke(P + 'rec-chunk', { clipId: c.clipId, seq, data })
          if (!r || !r.ok) throw new Error((r && r.error) || 'the data was not accepted')
        }).catch((err) => ev('error', { clipId: c.clipId, message: 'Could not save the recording: ' + msg(err) }))
      }
      rec.onstop = () => {
        const durationMs = c.t0 ? performance.now() - c.t0 : 0
        c.q = c.q.then(() => ev('stopped', { clipId: c.clipId, durationMs })).finally(() => cleanup(c))
      }
      rec.onerror = (e) => ev('error', { clipId: c.clipId, message: 'Recorder error: ' + msg(e && e.error) })
      vTrack.addEventListener('ended', () => { if (cur === c && !c.stopping) ev('ended', { clipId: c.clipId }) })
      cur = c
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('The recorder did not start')), 8000)
        rec.onstart = () => { clearTimeout(t); resolve() }
        try { rec.start(1000) } catch (e) { clearTimeout(t); reject(e) }
      })
      c.t0 = performance.now()
      c.timers.push(setInterval(() => ev('tick', { clipId: c.clipId, ms: performance.now() - c.t0 }), 2000))
      if (analyser) {
        const buf = new Float32Array(analyser.fftSize)
        c.timers.push(setInterval(() => {
          analyser.getFloatTimeDomainData(buf)
          let p = 0
          for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v }
          ev('level', { clipId: c.clipId, value: p })
        }, 150))
      }
      const st = vTrack.getSettings()
      ev('started', {
        clipId: o.clipId,
        width: st.width || o.width,
        height: st.height || o.height,
        mime: rec.mimeType || mimeType,
        hasAudio: !!audio,
        micLabel: mic ? ((mic.getAudioTracks()[0] || {}).label || '') : '',
        systemAudio: sys.length > 0,
        warnings
      })
    } catch (e) {
      if (c) cleanup(c)
      else owned.forEach((s) => s.getTracks().forEach((t) => { try { t.stop() } catch (x) {} }))
      ev('error', { clipId: o.clipId, phase: 'start', message: msg(e) })
    }
  }
  function stop(clipId) {
    const c = cur
    if (!c || c.clipId !== clipId) { ev('stopped', { clipId, durationMs: 0, missing: true }); return }
    if (c.stopping) return
    c.stopping = true
    try {
      if (c.rec.state !== 'inactive') c.rec.stop()
      else { ev('stopped', { clipId, durationMs: performance.now() - c.t0 }); cleanup(c) }
    } catch (e) { ev('stopped', { clipId, durationMs: performance.now() - c.t0 }); cleanup(c) }
  }
  api.on(P + 'rec-cmd', (cmd) => {
    if (!cmd || typeof cmd !== 'object') return
    if (cmd.cmd === 'start') start(cmd)
    else if (cmd.cmd === 'stop') stop(cmd.clipId)
  })
  api.invoke(P + 'rec-ready').catch(() => {})
})()
</script></body></html>`
}

export function overlayHtml(displayId: string): string {
  return `${HEAD}<title>ScreenRec</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;color:#fff;user-select:none;cursor:default}
body.hidden>*{display:none!important}
#dim{position:fixed;inset:0;background:rgba(7,9,13,.6);transition:background .12s}
#frame{position:fixed;inset:0;border:6px solid transparent;pointer-events:none;transition:border-color .12s}
body.pick:hover #dim{background:rgba(7,9,13,.4)}
body.pick:hover #frame{border-color:#3b82f6}
body.pick{cursor:pointer}
#region{position:fixed;display:none;border:3px solid #ef4444;box-shadow:0 0 0 200vmax rgba(7,9,13,.55);border-radius:3px;pointer-events:none}
body.armed #region,body.countdown #region{display:block}
body.armed #dim,body.countdown #dim{display:none}
.card{position:fixed;transform:translate(-50%,-50%);text-align:center;display:none;max-width:640px}
body.pick #pick,body.identify #pick{display:block}
body.armed #armed{display:block}
body.countdown #count{display:block}
body.identify #dim{background:rgba(7,9,13,.35)}
body.identify #hint{display:none}
.num{width:136px;height:136px;border-radius:50%;background:rgba(59,130,246,.2);border:3px solid #3b82f6;font-size:76px;font-weight:700;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;box-shadow:0 10px 40px rgba(0,0,0,.45)}
.title{font-size:26px;font-weight:600;text-shadow:0 2px 12px rgba(0,0,0,.6)}
.sub{font-size:15px;opacity:.82;margin-top:6px;text-shadow:0 1px 8px rgba(0,0,0,.6)}
.hint{margin-top:22px;font-size:15px;background:rgba(17,19,24,.85);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:9px 18px;display:inline-block}
.warn{margin-top:14px;font-size:13px;color:#fbbf24;display:none}
kbd{display:inline-block;min-width:22px;padding:1px 8px;border-radius:6px;background:#fff;color:#111;font:600 14px 'Segoe UI',system-ui;box-shadow:0 2px 0 rgba(0,0,0,.35);margin:0 2px}
.panel{background:rgba(17,19,24,.92);border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:22px 26px;box-shadow:0 18px 60px rgba(0,0,0,.55);min-width:420px}
.big{font-size:24px;font-weight:650;display:flex;align-items:center;justify-content:center;gap:10px}
.dot{width:14px;height:14px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 4px rgba(239,68,68,.25)}
.meta{font-size:13.5px;opacity:.8;margin-top:10px;line-height:1.55}
.btns{margin-top:16px;display:flex;gap:10px;justify-content:center}
button{font:600 14px 'Segoe UI',system-ui;border-radius:10px;padding:9px 16px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;cursor:pointer}
button.go{background:#ef4444;border-color:#ef4444}
button:hover{filter:brightness(1.12)}
#count .n{font-size:180px;font-weight:700;text-shadow:0 8px 40px rgba(0,0,0,.6);line-height:1}
</style></head><body class="hidden">
<div id="dim"></div><div id="frame"></div><div id="region"></div>
<div id="pick" class="card" style="left:50%;top:50%">
  <div class="num" id="pnum">1</div>
  <div class="title" id="plabel"></div>
  <div class="sub" id="pres"></div>
  <div class="hint" id="hint">Click to record this screen · or press <kbd id="pkey">1</kbd> · <kbd>Esc</kbd> cancels</div>
  <div class="warn" id="pwarn"></div>
</div>
<div id="armed" class="card">
  <div class="panel">
    <div class="big"><span class="dot"></span>Press <kbd>R</kbd> to start recording</div>
    <div class="meta" id="ameta"></div>
    <div class="warn" id="awarn"></div>
    <div class="btns"><button class="go" id="bstart">Start recording</button><button id="bcancel">Cancel (Esc)</button></div>
    <div class="meta" id="astop"></div>
  </div>
</div>
<div id="count" class="card"><div class="n" id="cn">3</div></div>
<script>
(() => {
  'use strict'
  const api = window.wicked
  const DISPLAY_ID = ${JSON.stringify(displayId)}
  let mode = 'hidden'
  const $ = (id) => document.getElementById(id)
  const act = (action, extra) => api.invoke('screen-rec:ov-action', Object.assign({ displayId: DISPLAY_ID, action }, extra || {})).catch(() => {})
  const place = (el, a) => { el.style.left = ((a.x + a.w / 2) * 100) + '%'; el.style.top = ((a.y + a.h / 2) * 100) + '%' }
  const setRegion = (a) => { const r = $('region'); r.style.left = (a.x * 100) + '%'; r.style.top = (a.y * 100) + '%'; r.style.width = (a.w * 100) + '%'; r.style.height = (a.h * 100) + '%' }
  const warn = (el, text) => { el.textContent = text || ''; el.style.display = text ? 'block' : 'none' }
  api.on('screen-rec:ov', (s) => {
    if (!s || typeof s !== 'object') return
    mode = s.mode || 'hidden'
    document.body.className = mode
    if (mode === 'pick' || mode === 'identify') {
      $('pnum').textContent = String(s.number)
      $('pkey').textContent = String(s.number)
      $('plabel').textContent = s.label + (s.primary ? ' (main display)' : '')
      $('pres').textContent = s.res
      warn($('pwarn'), s.warning)
    } else if (mode === 'armed') {
      setRegion(s.area); place($('armed'), s.area)
      $('ameta').innerHTML = ''
      const lines = ['Screen ' + s.number + ' · ' + s.label + ' · ' + s.areaText, 'Audio: ' + s.audio]
      lines.forEach((l) => { const d = document.createElement('div'); d.textContent = l; $('ameta').appendChild(d) })
      $('astop').textContent = 'Press ' + s.hotkey + ' again when you are done — the clip is added to this session.'
      warn($('awarn'), s.warning)
    } else if (mode === 'countdown') {
      setRegion(s.area); place($('count'), s.area)
      $('cn').textContent = String(s.n)
    }
  })
  document.addEventListener('mousedown', (e) => { if (mode === 'pick' && e.button === 0) act('select') })
  $('bstart').addEventListener('click', () => act('start'))
  $('bcancel').addEventListener('click', () => act('cancel'))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') act('cancel')
    else if (mode === 'armed' && (e.key === 'r' || e.key === 'R') && !e.ctrlKey) act('start')
    else if (mode === 'pick' && /^[1-9]$/.test(e.key)) act('key', { n: Number(e.key) })
  })
  document.addEventListener('contextmenu', (e) => e.preventDefault())
})()
</script></body></html>`
}

export function indicatorHtml(): string {
  return `${HEAD}<title>ScreenRec</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;color:#fff;user-select:none;cursor:default}
#wrap{display:flex;flex-direction:column;align-items:center;gap:4px;padding-top:3px}
.pill{display:flex;align-items:center;gap:10px;height:38px;padding:0 6px 0 14px;border-radius:999px;background:rgba(17,19,24,.94);border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 22px rgba(0,0,0,.45);font-size:13px;white-space:nowrap}
.pill.msg{white-space:normal;max-width:96%;box-sizing:border-box;padding:0 16px;height:auto;min-height:38px;border-radius:14px;flex-direction:column;align-items:flex-start;justify-content:center;gap:1px;padding-top:6px;padding-bottom:6px}
.dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.35}}
#time{font-weight:700;font-variant-numeric:tabular-nums;min-width:62px}
.bars{display:flex;align-items:flex-end;gap:2px;height:16px}
.bars i{width:3px;background:rgba(255,255,255,.18);border-radius:1px}
.bars i.on{background:#22c55e}
.bars i.hot{background:#f59e0b}
.hint{opacity:.7}
button{width:26px;height:26px;border-radius:50%;border:0;background:#ef4444;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
button span{width:9px;height:9px;background:#fff;border-radius:2px}
.row{display:flex;align-items:center;gap:8px;font-weight:600}
.sub{opacity:.72;font-size:12px}
.ok{color:#22c55e}.bad{color:#f87171}.amber{color:#fbbf24}
.spin{width:12px;height:12px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
.w{font-size:11.5px;color:#fbbf24;background:rgba(17,19,24,.94);border-radius:8px;padding:3px 10px;max-width:96%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body><div id="wrap"></div><script>
(() => {
  'use strict'
  const api = window.wicked
  const wrap = document.getElementById('wrap')
  let startedAt = 0, timer = null, level = 0
  const fmt = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0') }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  function bars() { const b = el('div', 'bars'); for (let i = 0; i < 6; i++) { const x = el('i'); x.style.height = (5 + i * 2) + 'px'; b.appendChild(x) } return b }
  function paintLevel() {
    const b = wrap.querySelector('.bars'); if (!b) return
    const db = level > 0 ? 20 * Math.log10(level) : -90
    const lit = Math.max(0, Math.min(6, Math.round((db + 54) / 9)))
    b.querySelectorAll('i').forEach((x, i) => { x.className = i < lit ? (i >= 5 ? 'hot' : 'on') : '' })
  }
  api.on('screen-rec:ind', (s) => {
    if (!s || typeof s !== 'object') return
    if (s.mode === 'level') { level = Number(s.value) || 0; paintLevel(); return }
    clearInterval(timer); timer = null
    wrap.innerHTML = ''
    if (s.mode === 'recording') {
      startedAt = Number(s.startedAt) || Date.now()
      const p = el('div', 'pill')
      p.appendChild(el('span', 'dot'))
      const t = el('span', null, 'REC 0:00'); t.id = 'time'; p.appendChild(t)
      if (s.hasAudio) p.appendChild(bars())
      p.appendChild(el('span', 'hint', s.hotkey + ' to stop'))
      const b = el('button'); b.title = 'Stop recording'; b.appendChild(el('span')); b.addEventListener('click', () => api.invoke('screen-rec:ind-action', 'stop').catch(() => {}))
      p.appendChild(b)
      wrap.appendChild(p)
      if (s.warning) wrap.appendChild(el('div', 'w', s.warning))
      const tick = () => { t.textContent = 'REC ' + fmt(Date.now() - startedAt) }
      tick(); timer = setInterval(tick, 250)
      paintLevel()
    } else if (s.mode === 'starting') {
      const p = el('div', 'pill'); p.style.paddingRight = '16px'
      p.appendChild(el('span', 'spin')); p.appendChild(el('span', null, 'Starting recording…'))
      wrap.appendChild(p)
    } else {
      const p = el('div', 'pill msg')
      const r = el('div', 'row')
      r.appendChild(el('span', s.mode === 'saved' ? 'ok' : s.mode === 'error' ? 'bad' : 'amber', s.mode === 'saved' ? '✓' : '!'))
      r.appendChild(el('span', null, s.text || ''))
      p.appendChild(r)
      if (s.sub) p.appendChild(el('div', 'sub', s.sub))
      wrap.appendChild(p)
    }
  })
})()
</script></body></html>`
}
