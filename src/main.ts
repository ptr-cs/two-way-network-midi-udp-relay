import { Midi } from '@tonejs/midi'
import './style.css'

type Settings = {
  host: string
  remotePort: number
  listenPort: number
  address: string
  channel: number
  note: number
  velocity: number
  durationMs: number
  tempo: number
  monitorEnabled: boolean
}

type TransmitResponse = {
  ok: true
  destination: string
  address: string
  noteOn: number[]
  noteOff: number[]
  durationMs: number
  sentAt: string
}

type HealthResponse = {
  ok: true
  listenPort: number
  lanAddresses: string[]
}

type IncomingNote = {
  direction: 'incoming'
  event: 'noteOn' | 'noteOff'
  oscAddress: string
  status: number
  channel: number
  note: number
  velocity: number
  sender: string
  senderPort: number | null
  receivedAt: string
}

type MidiNotePayload = {
  ticks: number
  durationTicks: number
  note: number
  velocity: number
  channel: number
}

type ParsedMidi = {
  title: string
  ppq: number
  noteCount: number
  trackCount: number
  originalBpm: number
  durationTicks: number
  notes: MidiNotePayload[]
}

type SequenceResponse = {
  ok: true
  id: string
  title: string
  bpm: number
  noteCount: number
  durationMs: number
  destination: string
  startsAt: string
}

type Voice = {
  oscillator: OscillatorNode
  gain: GainNode
  cleanup: number
}

const STORAGE_KEY = 'relay-osc-settings-v2'
const defaults: Settings = {
  host: '127.0.0.1',
  remotePort: 9001,
  listenPort: 9001,
  address: '/midi',
  channel: 1,
  note: 60,
  velocity: 100,
  durationMs: 500,
  tempo: 120,
  monitorEnabled: false,
}

function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') }
  } catch {
    return defaults
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

const settings = loadSettings()
const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('App root was not found')

app.innerHTML = `
  <header class="site-header">
    <a class="brand" href="#" aria-label="Relay home">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>RELAY</span>
    </a>
    <div class="bridge-state" id="bridge-state">
      <span class="state-dot"></span>
      <span>Checking local bridge</span>
    </div>
  </header>

  <main>
    <section class="intro" aria-labelledby="page-title">
      <p class="eyebrow">OSC / UDP &nbsp;·&nbsp; TWO-WAY SESSION</p>
      <h1 id="page-title">Play it forward.<br /><em>Hear it come back.</em></h1>
      <p class="lede">
        Both musicians run Relay. Send a single note or an entire MIDI file,
        and monitor the notes arriving from the other side.
      </p>
      <div class="route-line two-way" aria-hidden="true">
        <span class="route-origin">YOU</span>
        <span class="route-track"><i></i><b></b></span>
        <span class="route-destination">THEM</span>
      </div>
    </section>

    <section class="console" aria-label="OSC MIDI connection">
      <form id="transmit-form">
        <div class="section-heading">
          <span>01</span>
          <div>
            <h2>Your friend</h2>
            <p>Where outgoing notes should go</p>
          </div>
        </div>

        <div class="field-grid network-grid">
          <label class="field field-wide">
            <span>Friend’s IP address or hostname</span>
            <input id="host" name="host" autocomplete="off" required value="${escapeHtml(settings.host)}" placeholder="192.168.1.42" />
          </label>
          <label class="field">
            <span>Their listening port</span>
            <input id="remotePort" name="remotePort" type="number" inputmode="numeric" min="1" max="65535" required value="${settings.remotePort}" />
          </label>
          <label class="field">
            <span>OSC address</span>
            <input id="address" name="address" required maxlength="200" pattern="/.*" value="${escapeHtml(settings.address)}" />
          </label>
        </div>

        <div class="listen-card">
          <div>
            <span class="packet-label">YOUR RECEIVER</span>
            <strong id="local-addresses">Finding LAN address…</strong>
            <small>Share this address and port with your friend</small>
          </div>
          <label class="compact-field">
            <span>Port</span>
            <input id="listenPort" name="listenPort" type="number" inputmode="numeric" min="1" max="65535" required value="${settings.listenPort}" />
          </label>
          <button class="outline-button" id="apply-listener" type="button">Apply</button>
        </div>

        <div class="divider"></div>

        <div class="section-heading">
          <span>02</span>
          <div>
            <h2>Test note</h2>
            <p>A paired note-on and note-off message</p>
          </div>
        </div>

        <div class="field-grid midi-grid">
          <label class="field">
            <span>Channel</span>
            <input id="channel" name="channel" type="number" inputmode="numeric" min="1" max="16" required value="${settings.channel}" />
          </label>
          <label class="field">
            <span>Note</span>
            <input id="note" name="note" type="number" inputmode="numeric" min="0" max="127" required value="${settings.note}" />
          </label>
          <label class="field">
            <span>Velocity</span>
            <input id="velocity" name="velocity" type="number" inputmode="numeric" min="0" max="127" required value="${settings.velocity}" />
          </label>
          <label class="field">
            <span>Hold (ms)</span>
            <input id="durationMs" name="durationMs" type="number" inputmode="numeric" min="50" max="10000" step="10" required value="${settings.durationMs}" />
          </label>
        </div>

        <div class="packet-preview" aria-live="polite">
          <div>
            <span class="packet-label">MESSAGE PREVIEW</span>
            <strong id="note-name">C4</strong>
          </div>
          <code id="packet-preview">/midi&nbsp;&nbsp;144&nbsp;&nbsp;60&nbsp;&nbsp;100</code>
        </div>

        <button class="send-button" id="send-button" type="submit">
          <span>Transmit test note</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
        </button>
      </form>
    </section>

    <section class="monitor-panel" aria-labelledby="monitor-title">
      <div class="monitor-copy">
        <p class="eyebrow">LIVE INPUT</p>
        <h2 id="monitor-title">Incoming monitor</h2>
        <p>Notes arriving from your friend appear here and can be auditioned in this browser.</p>
        <button class="monitor-toggle ${settings.monitorEnabled ? 'enabled' : ''}" id="monitor-toggle" type="button" aria-pressed="${settings.monitorEnabled}">
          <span class="toggle-dot"></span>
          <span id="monitor-label">Audio monitor ${settings.monitorEnabled ? 'on' : 'off'}</span>
        </button>
      </div>
      <div class="note-display idle" id="note-display">
        <span class="receive-label">WAITING FOR A NOTE</span>
        <strong id="received-note">—</strong>
        <small id="received-detail">Listening on UDP ${settings.listenPort}</small>
        <div class="signal-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      </div>
    </section>

    <section class="midi-player" aria-labelledby="midi-title">
      <div class="player-heading">
        <div>
          <p class="eyebrow">SEQUENCE TRANSMISSION</p>
          <h2 id="midi-title">Send a MIDI file</h2>
          <p>Relay preserves the file’s note positions and durations, then re-times them to your chosen tempo.</p>
        </div>
        <div class="tempo-control">
          <label for="tempo">TEMPO</label>
          <div><input id="tempo" type="number" min="20" max="400" step="1" value="${settings.tempo}" /><span>BPM</span></div>
        </div>
      </div>

      <label class="file-drop" id="file-drop" for="midi-file">
        <input id="midi-file" type="file" accept=".mid,.midi,audio/midi,audio/x-midi" />
        <span class="file-icon" aria-hidden="true">↥</span>
        <span><strong>Choose a MIDI file</strong><small>or drop a .mid file here</small></span>
      </label>

      <div class="file-ready" id="file-ready" hidden>
        <div class="file-identity">
          <span class="file-type">MID</span>
          <div><strong id="file-name"></strong><small id="file-details"></small></div>
        </div>
        <div class="player-actions">
          <button class="outline-button stop-button" id="stop-sequence" type="button" disabled>Stop</button>
          <button class="play-button" id="play-sequence" type="button"><span>Send file</span><i>▶</i></button>
        </div>
        <div class="playback-progress"><i id="playback-progress"></i></div>
        <small class="playback-status" id="playback-status">Ready to transmit</small>
      </div>
    </section>

    <section class="instructions" aria-labelledby="setup-title">
      <div>
        <p class="eyebrow">PAIRING CHECKLIST</p>
        <h2 id="setup-title">Connect both sides</h2>
      </div>
      <ol>
        <li><span>1</span><p>Both people run <code>npm run dev</code> and leave Relay open.</p></li>
        <li><span>2</span><p>Exchange the LAN address and listening port displayed above.</p></li>
        <li><span>3</span><p>Allow incoming UDP traffic if either firewall asks.</p></li>
      </ol>
    </section>

    <section class="activity" aria-labelledby="activity-title">
      <div class="activity-heading">
        <h2 id="activity-title">Session activity</h2>
        <button type="button" id="clear-log">Clear</button>
      </div>
      <div class="empty-log" id="empty-log">No notes sent or received yet.</div>
      <ul id="activity-log" aria-live="polite"></ul>
    </section>
  </main>

  <footer>
    <span>RELAY / TWO-WAY OSC MIDI</span>
    <span>LOCAL-FIRST · NO CLOUD</span>
  </footer>
`

const form = document.querySelector<HTMLFormElement>('#transmit-form')!
const sendButton = document.querySelector<HTMLButtonElement>('#send-button')!
const bridgeState = document.querySelector<HTMLDivElement>('#bridge-state')!
const preview = document.querySelector<HTMLElement>('#packet-preview')!
const noteName = document.querySelector<HTMLElement>('#note-name')!
const activityLog = document.querySelector<HTMLUListElement>('#activity-log')!
const emptyLog = document.querySelector<HTMLDivElement>('#empty-log')!
const localAddresses = document.querySelector<HTMLElement>('#local-addresses')!
const listenPortInput = document.querySelector<HTMLInputElement>('#listenPort')!
const monitorToggle = document.querySelector<HTMLButtonElement>('#monitor-toggle')!
const monitorLabel = document.querySelector<HTMLElement>('#monitor-label')!
const noteDisplay = document.querySelector<HTMLDivElement>('#note-display')!
const receivedNote = document.querySelector<HTMLElement>('#received-note')!
const receivedDetail = document.querySelector<HTMLElement>('#received-detail')!
const tempoInput = document.querySelector<HTMLInputElement>('#tempo')!
const fileInput = document.querySelector<HTMLInputElement>('#midi-file')!
const fileDrop = document.querySelector<HTMLLabelElement>('#file-drop')!
const fileReady = document.querySelector<HTMLDivElement>('#file-ready')!
const playButton = document.querySelector<HTMLButtonElement>('#play-sequence')!
const stopButton = document.querySelector<HTMLButtonElement>('#stop-sequence')!
const playbackProgress = document.querySelector<HTMLElement>('#playback-progress')!
const playbackStatus = document.querySelector<HTMLElement>('#playback-status')!

let parsedMidi: ParsedMidi | null = null
let sequenceAnimation = 0
let monitorEnabled = settings.monitorEnabled
let audioContext: AudioContext | null = null
const voices = new Map<string, Voice>()

function numberValue(name: keyof Settings): number {
  return Number(new FormData(form).get(name))
}

function currentSettings(): Settings {
  const data = new FormData(form)
  return {
    host: String(data.get('host') ?? '').trim(),
    remotePort: numberValue('remotePort'),
    listenPort: numberValue('listenPort'),
    address: String(data.get('address') ?? '').trim(),
    channel: numberValue('channel'),
    note: numberValue('note'),
    velocity: numberValue('velocity'),
    durationMs: numberValue('durationMs'),
    tempo: Number(tempoInput.value),
    monitorEnabled,
  }
}

function saveSettings(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings()))
}

function midiNoteName(note: number): string {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
  const normalized = Math.max(0, Math.min(127, Number.isFinite(note) ? note : 60))
  return `${names[normalized % 12]}${Math.floor(normalized / 12) - 1}`
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function updatePreview(): void {
  const next = currentSettings()
  const status = 0x90 | (Math.max(1, Math.min(16, next.channel || 1)) - 1)
  preview.textContent = `${next.address || '/midi'}  ${status}  ${next.note || 0}  ${next.velocity || 0}`
  noteName.textContent = midiNoteName(next.note)
  saveSettings()
  renderMidiDetails()
}

form.addEventListener('input', updatePreview)
tempoInput.addEventListener('input', updatePreview)
updatePreview()

function addLog(kind: 'sent' | 'received' | 'error' | 'system', title: string, detail: string): void {
  emptyLog.hidden = true
  const item = document.createElement('li')
  item.className = `log-entry ${kind}`
  const icon = kind === 'received' ? '↙' : kind === 'sent' ? '↗' : kind === 'error' ? '!' : '•'
  item.innerHTML = `
    <span class="log-icon">${icon}</span>
    <div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div>
    <time>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
  `
  activityLog.prepend(item)
  while (activityLog.children.length > 60) activityLog.lastElementChild?.remove()
}

document.querySelector<HTMLButtonElement>('#clear-log')!.addEventListener('click', () => {
  activityLog.replaceChildren()
  emptyLog.hidden = false
})

function setBridgeState(state: 'online' | 'offline', label: string): void {
  bridgeState.className = `bridge-state ${state}`
  bridgeState.innerHTML = `<span class="state-dot"></span><span>${escapeHtml(label)}</span>`
}

function renderAddresses(addresses: string[], port: number): void {
  const address = addresses[0] ?? 'No LAN address found'
  localAddresses.textContent = addresses.length ? `${address}:${port}` : address
  receivedDetail.textContent = `Listening on UDP ${port}`
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const body = await response.json() as T | { error: string }
  if (!response.ok) {
    throw new Error('error' in (body as object) ? (body as { error: string }).error : 'Request failed')
  }
  return body as T
}

async function applyListener(logChange = true): Promise<void> {
  const port = Number(listenPortInput.value)
  const result = await fetchJson<{ ok: true; port: number; lanAddresses: string[] }>('/api/listener', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  })
  listenPortInput.value = String(result.port)
  renderAddresses(result.lanAddresses, result.port)
  setBridgeState('online', `Listening on UDP ${result.port}`)
  saveSettings()
  if (logChange) addLog('system', 'Listening port updated', `Incoming OSC is now accepted on UDP ${result.port}`)
}

document.querySelector<HTMLButtonElement>('#apply-listener')!.addEventListener('click', async () => {
  try {
    await applyListener()
  } catch (error) {
    addLog('error', 'Could not change listening port', error instanceof Error ? error.message : 'Unknown error')
  }
})

async function initializeBridge(): Promise<void> {
  try {
    const health = await fetchJson<HealthResponse>('/api/health')
    if (settings.listenPort !== health.listenPort) await applyListener(false)
    else {
      renderAddresses(health.lanAddresses, health.listenPort)
      setBridgeState('online', `Listening on UDP ${health.listenPort}`)
    }
  } catch {
    setBridgeState('offline', 'Local bridge offline')
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!form.reportValidity()) return

  const next = currentSettings()
  sendButton.disabled = true
  sendButton.classList.add('sending')
  sendButton.querySelector('span')!.textContent = 'Dispatching…'

  try {
    const result = await fetchJson<TransmitResponse>('/api/transmit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: next.host,
        port: next.remotePort,
        address: next.address,
        channel: next.channel,
        note: next.note,
        velocity: next.velocity,
        durationMs: next.durationMs,
      }),
    })
    addLog(
      'sent',
      `Sent ${midiNoteName(next.note)} to ${result.destination}`,
      `${result.address} · [${result.noteOn.join(', ')}] · note-off in ${result.durationMs} ms`,
    )
  } catch (error) {
    addLog('error', 'Transmission failed', error instanceof Error ? error.message : 'Unknown error')
  } finally {
    sendButton.disabled = false
    sendButton.classList.remove('sending')
    sendButton.querySelector('span')!.textContent = 'Transmit test note'
  }
})

async function ensureAudio(): Promise<AudioContext> {
  audioContext ??= new AudioContext()
  if (audioContext.state === 'suspended') await audioContext.resume()
  return audioContext
}

function releaseVoice(key: string): void {
  const voice = voices.get(key)
  if (!voice || !audioContext) return
  window.clearTimeout(voice.cleanup)
  const now = audioContext.currentTime
  voice.gain.gain.cancelScheduledValues(now)
  voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now)
  voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
  voice.oscillator.stop(now + 0.2)
  voices.delete(key)
}

async function monitorNote(event: IncomingNote): Promise<void> {
  if (!monitorEnabled) return
  const context = await ensureAudio()
  const key = `${event.sender}:${event.channel}:${event.note}`

  if (event.event === 'noteOff') {
    releaseVoice(key)
    return
  }

  releaseVoice(key)
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = event.channel === 10 ? 'square' : 'triangle'
  oscillator.frequency.value = 440 * (2 ** ((event.note - 69) / 12))
  gain.gain.setValueAtTime(0.0001, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(Math.max(0.008, event.velocity / 127 * 0.12), context.currentTime + 0.015)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start()
  const cleanup = window.setTimeout(() => releaseVoice(key), 30_000)
  voices.set(key, { oscillator, gain, cleanup })
}

monitorToggle.addEventListener('click', async () => {
  monitorEnabled = !monitorEnabled
  if (monitorEnabled) await ensureAudio()
  else for (const key of voices.keys()) releaseVoice(key)
  monitorToggle.classList.toggle('enabled', monitorEnabled)
  monitorToggle.setAttribute('aria-pressed', String(monitorEnabled))
  monitorLabel.textContent = `Audio monitor ${monitorEnabled ? 'on' : 'off'}`
  saveSettings()
})

window.addEventListener('pointerdown', () => {
  if (monitorEnabled) void ensureAudio()
}, { once: true })

function handleIncomingNote(event: IncomingNote): void {
  receivedNote.textContent = midiNoteName(event.note)
  receivedDetail.textContent = `Channel ${event.channel} · velocity ${event.velocity} · from ${event.sender}`
  noteDisplay.classList.remove('idle', 'note-off')
  noteDisplay.classList.toggle('note-off', event.event === 'noteOff')
  noteDisplay.classList.remove('pulse')
  void noteDisplay.offsetWidth
  noteDisplay.classList.add('pulse')

  if (event.event === 'noteOn') {
    addLog('received', `Received ${midiNoteName(event.note)} from ${event.sender}`, `Channel ${event.channel} · velocity ${event.velocity}`)
  }
  void monitorNote(event)
}

const events = new EventSource('/api/events')
events.addEventListener('ready', (raw) => {
  const event = JSON.parse((raw as MessageEvent).data) as { port: number }
  setBridgeState('online', `Listening on UDP ${event.port}`)
})
events.addEventListener('listener', (raw) => {
  const event = JSON.parse((raw as MessageEvent).data) as { port: number }
  setBridgeState('online', `Listening on UDP ${event.port}`)
})
events.addEventListener('note', (raw) => {
  handleIncomingNote(JSON.parse((raw as MessageEvent).data) as IncomingNote)
})
events.addEventListener('bridge-error', (raw) => {
  const event = JSON.parse((raw as MessageEvent).data) as { message: string }
  addLog('error', 'OSC bridge error', event.message)
})
events.addEventListener('sequence', (raw) => {
  const event = JSON.parse((raw as MessageEvent).data) as { state: string; title: string }
  if (event.state === 'complete') finishSequenceUi(`Finished sending ${event.title}`)
  if (event.state === 'stopped') finishSequenceUi(`Stopped ${event.title}`)
})
events.onerror = () => setBridgeState('offline', 'Reconnecting to local bridge')

function parseMidiFile(file: File): Promise<ParsedMidi> {
  return file.arrayBuffer().then((buffer) => {
    const midi = new Midi(buffer)
    const notes = midi.tracks.flatMap((track) => track.notes.map((note): MidiNotePayload => ({
      ticks: Math.max(0, Math.round(note.ticks)),
      durationTicks: Math.max(1, Math.round(note.durationTicks)),
      note: Math.max(0, Math.min(127, Math.round(note.midi))),
      velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127))),
      channel: Math.max(1, Math.min(16, Math.round(track.channel) + 1)),
    })))

    if (!notes.length) throw new Error('This MIDI file contains no note events')

    return {
      title: midi.name || file.name.replace(/\.(mid|midi)$/i, ''),
      ppq: midi.header.ppq,
      noteCount: notes.length,
      trackCount: midi.tracks.length,
      originalBpm: Math.round(midi.header.tempos[0]?.bpm ?? 120),
      durationTicks: Math.max(...notes.map((note) => note.ticks + note.durationTicks)),
      notes,
    }
  })
}

async function loadMidiFile(file?: File): Promise<void> {
  if (!file) return
  try {
    parsedMidi = await parseMidiFile(file)
    document.querySelector<HTMLElement>('#file-name')!.textContent = file.name
    fileDrop.hidden = true
    fileReady.hidden = false
    renderMidiDetails()
    addLog('system', 'MIDI file loaded', `${file.name} · ${parsedMidi.noteCount.toLocaleString()} notes`)
  } catch (error) {
    parsedMidi = null
    addLog('error', 'Could not read MIDI file', error instanceof Error ? error.message : 'Unknown error')
  }
}

fileInput.addEventListener('change', () => void loadMidiFile(fileInput.files?.[0]))
for (const eventName of ['dragenter', 'dragover']) {
  fileDrop.addEventListener(eventName, (event) => {
    event.preventDefault()
    fileDrop.classList.add('dragging')
  })
}
for (const eventName of ['dragleave', 'drop']) {
  fileDrop.addEventListener(eventName, (event) => {
    event.preventDefault()
    fileDrop.classList.remove('dragging')
  })
}
fileDrop.addEventListener('drop', (event) => void loadMidiFile(event.dataTransfer?.files[0]))

function renderMidiDetails(): void {
  if (!parsedMidi) return
  const bpm = Math.max(20, Math.min(400, Number(tempoInput.value) || 120))
  const durationMs = parsedMidi.durationTicks * 60_000 / (bpm * parsedMidi.ppq)
  document.querySelector<HTMLElement>('#file-details')!.textContent =
    `${parsedMidi.noteCount.toLocaleString()} notes · ${parsedMidi.trackCount} tracks · ${formatDuration(durationMs)} at ${bpm} BPM · original ${parsedMidi.originalBpm} BPM`
}

function animateSequence(startTime: number, durationMs: number): void {
  cancelAnimationFrame(sequenceAnimation)
  const frame = () => {
    const progress = Math.max(0, Math.min(1, (Date.now() - startTime) / durationMs))
    playbackProgress.style.width = `${progress * 100}%`
    playbackStatus.textContent = `Transmitting · ${formatDuration(progress * durationMs)} / ${formatDuration(durationMs)}`
    if (progress < 1) sequenceAnimation = requestAnimationFrame(frame)
  }
  frame()
}

function finishSequenceUi(message: string): void {
  cancelAnimationFrame(sequenceAnimation)
  playButton.disabled = false
  stopButton.disabled = true
  playbackProgress.style.width = '0%'
  playbackStatus.textContent = message
}

playButton.addEventListener('click', async () => {
  if (!parsedMidi) return
  const next = currentSettings()
  if (!form.reportValidity()) return

  playButton.disabled = true
  stopButton.disabled = false
  playbackStatus.textContent = 'Preparing transmission…'

  try {
    const result = await fetchJson<SequenceResponse>('/api/sequence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: next.host,
        port: next.remotePort,
        address: next.address,
        title: parsedMidi.title,
        bpm: next.tempo,
        ppq: parsedMidi.ppq,
        notes: parsedMidi.notes,
      }),
    })
    animateSequence(new Date(result.startsAt).getTime(), result.durationMs)
    addLog('sent', `Sending ${result.title}`, `${result.noteCount.toLocaleString()} notes · ${result.bpm} BPM · ${result.destination}`)
  } catch (error) {
    finishSequenceUi('Transmission failed')
    addLog('error', 'MIDI transmission failed', error instanceof Error ? error.message : 'Unknown error')
  }
})

stopButton.addEventListener('click', async () => {
  try {
    await fetchJson<{ ok: true; stopped: boolean }>('/api/sequence/stop', { method: 'POST' })
  } catch (error) {
    addLog('error', 'Could not stop MIDI transmission', error instanceof Error ? error.message : 'Unknown error')
  } finally {
    finishSequenceUi('Transmission stopped')
  }
})

void initializeBridge()
