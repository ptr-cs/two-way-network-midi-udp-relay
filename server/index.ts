import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, resolve, sep } from 'node:path'
import OSC from 'osc-js'

type Destination = {
  host: string
  port: number
  address: string
}

type TransmitRequest = Destination & {
  channel: number
  note: number
  velocity: number
  durationMs: number
}

type SequenceNote = {
  ticks: number
  durationTicks: number
  note: number
  velocity: number
  channel: number
}

type SequenceRequest = Destination & {
  title: string
  bpm: number
  ppq: number
  notes: SequenceNote[]
}

type ScheduledMidiEvent = {
  atMs: number
  status: number
  note: number
  velocity: number
  channel: number
  isNoteOn: boolean
}

type SequencePlayback = {
  id: string
  title: string
  bpm: number
  noteCount: number
  durationMs: number
  destination: Destination
  events: ScheduledMidiEvent[]
  index: number
  startedAt: number
  activeNotes: Map<number, { channel: number; note: number }>
  timer?: NodeJS.Timeout
}

type OscMessage = {
  address: string
  args: unknown[]
}

type RemoteInfo = {
  address?: string
  port?: number
}

const HTTP_HOST = '127.0.0.1'
const HTTP_PORT = 8787
const DEFAULT_OSC_PORT = 9001
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_SEQUENCE_NOTES = 20_000
const serveStatic = process.argv.includes('--serve-static')
const distRoot = resolve(process.cwd(), 'dist')
const sseClients = new Set<ServerResponse>()
let sequence: SequencePlayback | null = null

function broadcast(event: string, payload: unknown): void {
  const packet = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const client of sseClients) client.write(packet)
}

function decodeIncoming(message: OscMessage, sender?: RemoteInfo): void {
  if (!Array.isArray(message.args) || message.args.length < 3) return

  const status = Number(message.args[0])
  const note = Number(message.args[1])
  const velocity = Number(message.args[2])
  if (![status, note, velocity].every(Number.isInteger)) return
  if (status < 0 || status > 255 || note < 0 || note > 127 || velocity < 0 || velocity > 127) return

  const command = status & 0xf0
  const isNoteOn = command === 0x90 && velocity > 0
  const isNoteOff = command === 0x80 || (command === 0x90 && velocity === 0)
  if (!isNoteOn && !isNoteOff) return

  const event = {
    direction: 'incoming' as const,
    event: isNoteOn ? 'noteOn' as const : 'noteOff' as const,
    oscAddress: message.address,
    status,
    channel: (status & 0x0f) + 1,
    note,
    velocity,
    sender: sender?.address ?? 'unknown',
    senderPort: sender?.port ?? null,
    receivedAt: new Date().toISOString(),
  }

  console.log(`[osc] received ${message.address} [${status}, ${note}, ${velocity}] from ${event.sender}`)
  broadcast('note', event)
}

class OscTransport {
  private instance: OSC | null = null
  listenPort = 0

  async listen(port: number): Promise<void> {
    if (this.instance && this.listenPort === port) return

    const candidate = new OSC({
      plugin: new OSC.DatagramPlugin({ type: 'udp4' }),
    })

    candidate.on('*', (message: OscMessage, sender?: RemoteInfo) => {
      decodeIncoming(message, sender)
    })

    await new Promise<void>((resolveOpen, rejectOpen) => {
      let opened = false

      candidate.on('open', () => {
        opened = true
        resolveOpen()
      })
      candidate.on('error', (error: Error) => {
        console.error(`[osc] ${error.message}`)
        if (!opened) rejectOpen(error)
        else broadcast('bridge-error', { message: error.message })
      })
      candidate.open({ host: '0.0.0.0', port, exclusive: false })
    })

    const previous = this.instance
    this.instance = candidate
    this.listenPort = port
    previous?.close()

    console.log(`[osc] listening on UDP 0.0.0.0:${port}`)
    broadcast('listener', { port })
  }

  send(address: string, bytes: number[], target: { host: string; port: number }): void {
    if (!this.instance) throw new Error('OSC transport is not ready')
    this.instance.send(new OSC.Message(address, ...bytes), target)
  }

  close(): void {
    this.instance?.close()
    this.instance = null
    this.listenPort = 0
  }
}

const transport = new OscTransport()
await transport.listen(DEFAULT_OSC_PORT)

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(buffer)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Request body must be valid JSON')
  }
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value as number
}

function finiteNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`)
  }
  return value
}

function validateDestination(input: Record<string, unknown>): Destination {
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  const address = typeof input.address === 'string' ? input.address.trim() : ''

  if (!host || host.length > 253 || /[\s/\\\0]/.test(host)) {
    throw new Error('Enter a valid IPv4 address or hostname')
  }
  if (!address.startsWith('/') || address.length > 200 || address.includes('\0')) {
    throw new Error('OSC address must begin with / and be at most 200 characters')
  }

  return {
    host,
    address,
    port: integer(input.port, 'Destination port', 1, 65535),
  }
}

function validateTransmitRequest(value: unknown): TransmitRequest {
  if (!value || typeof value !== 'object') throw new Error('A settings object is required')
  const input = value as Record<string, unknown>

  return {
    ...validateDestination(input),
    channel: integer(input.channel, 'Channel', 1, 16),
    note: integer(input.note, 'Note', 0, 127),
    velocity: integer(input.velocity, 'Velocity', 0, 127),
    durationMs: integer(input.durationMs, 'Hold time', 50, 10_000),
  }
}

function validateSequenceRequest(value: unknown): SequenceRequest {
  if (!value || typeof value !== 'object') throw new Error('A MIDI sequence is required')
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.notes) || input.notes.length === 0) throw new Error('The MIDI file contains no notes')
  if (input.notes.length > MAX_SEQUENCE_NOTES) {
    throw new Error(`MIDI files are limited to ${MAX_SEQUENCE_NOTES.toLocaleString()} notes`)
  }

  const notes = input.notes.map((value, index): SequenceNote => {
    if (!value || typeof value !== 'object') throw new Error(`Note ${index + 1} is invalid`)
    const note = value as Record<string, unknown>
    return {
      ticks: integer(note.ticks, `Note ${index + 1} start`, 0, 100_000_000),
      durationTicks: integer(note.durationTicks, `Note ${index + 1} duration`, 1, 100_000_000),
      note: integer(note.note, `Note ${index + 1} pitch`, 0, 127),
      velocity: integer(note.velocity, `Note ${index + 1} velocity`, 1, 127),
      channel: integer(note.channel, `Note ${index + 1} channel`, 1, 16),
    }
  })

  return {
    ...validateDestination(input),
    title: typeof input.title === 'string' && input.title.trim()
      ? input.title.trim().slice(0, 200)
      : 'Untitled MIDI file',
    bpm: finiteNumber(input.bpm, 'Tempo', 20, 400),
    ppq: integer(input.ppq, 'PPQ', 1, 32_768),
    notes,
  }
}

function transmit(settings: TransmitRequest) {
  const channelIndex = settings.channel - 1
  const noteOn = [0x90 | channelIndex, settings.note, settings.velocity]
  const noteOff = [0x80 | channelIndex, settings.note, 0]
  const target = { host: settings.host, port: settings.port }

  transport.send(settings.address, noteOn, target)

  const noteOffTimer = setTimeout(() => {
    transport.send(settings.address, noteOff, target)
  }, settings.durationMs)
  noteOffTimer.unref()

  return {
    ok: true as const,
    destination: `${settings.host}:${settings.port}`,
    address: settings.address,
    noteOn,
    noteOff,
    durationMs: settings.durationMs,
    sentAt: new Date().toISOString(),
  }
}

function stopSequence(reason: 'stopped' | 'replaced' | 'shutdown' = 'stopped'): boolean {
  if (!sequence) return false

  if (sequence.timer) clearTimeout(sequence.timer)
  const stopped = sequence

  for (const active of stopped.activeNotes.values()) {
    transport.send(
      stopped.destination.address,
      [0x80 | (active.channel - 1), active.note, 0],
      stopped.destination,
    )
  }

  sequence = null
  broadcast('sequence', {
    state: reason,
    id: stopped.id,
    title: stopped.title,
  })
  return true
}

function runSequenceStep(playback: SequencePlayback): void {
  if (sequence?.id !== playback.id) return

  const elapsed = performance.now() - playback.startedAt
  while (playback.index < playback.events.length) {
    const event = playback.events[playback.index]
    if (!event || event.atMs > elapsed + 1) break

    transport.send(
      playback.destination.address,
      [event.status, event.note, event.velocity],
      playback.destination,
    )

    const key = (event.channel << 8) | event.note
    if (event.isNoteOn) playback.activeNotes.set(key, { channel: event.channel, note: event.note })
    else playback.activeNotes.delete(key)
    playback.index += 1
  }

  if (playback.index >= playback.events.length) {
    sequence = null
    broadcast('sequence', {
      state: 'complete',
      id: playback.id,
      title: playback.title,
    })
    return
  }

  const next = playback.events[playback.index]
  const delay = Math.max(0, Math.min(1000, (next?.atMs ?? elapsed) - (performance.now() - playback.startedAt)))
  playback.timer = setTimeout(() => runSequenceStep(playback), delay)
}

function startSequence(settings: SequenceRequest) {
  stopSequence('replaced')

  const millisecondsPerTick = 60_000 / (settings.bpm * settings.ppq)
  const events: ScheduledMidiEvent[] = []

  for (const note of settings.notes) {
    const start = note.ticks * millisecondsPerTick
    const end = (note.ticks + note.durationTicks) * millisecondsPerTick
    events.push({
      atMs: start,
      status: 0x90 | (note.channel - 1),
      note: note.note,
      velocity: note.velocity,
      channel: note.channel,
      isNoteOn: true,
    })
    events.push({
      atMs: Math.max(start + 10, end),
      status: 0x80 | (note.channel - 1),
      note: note.note,
      velocity: 0,
      channel: note.channel,
      isNoteOn: false,
    })
  }

  events.sort((left, right) => left.atMs - right.atMs || Number(left.isNoteOn) - Number(right.isNoteOn))
  const durationMs = events.at(-1)?.atMs ?? 0
  const id = crypto.randomUUID()
  const playback: SequencePlayback = {
    id,
    title: settings.title,
    bpm: settings.bpm,
    noteCount: settings.notes.length,
    durationMs,
    destination: {
      host: settings.host,
      port: settings.port,
      address: settings.address,
    },
    events,
    index: 0,
    startedAt: performance.now() + 100,
    activeNotes: new Map(),
  }

  sequence = playback
  playback.timer = setTimeout(() => runSequenceStep(playback), 100)

  const result = {
    ok: true as const,
    id,
    title: settings.title,
    bpm: settings.bpm,
    noteCount: settings.notes.length,
    durationMs,
    destination: `${settings.host}:${settings.port}`,
    startsAt: new Date(Date.now() + 100).toISOString(),
  }
  broadcast('sequence', { state: 'started', ...result })
  return result
}

function getLanAddresses(): string[] {
  const addresses = new Set<string>()
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const network of interfaces ?? []) {
      if (network.family === 'IPv4' && !network.internal) addresses.add(network.address)
    }
  }
  return [...addresses]
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

async function serveBuiltApp(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  let filePath = resolve(distRoot, requested)
  const insideDist = filePath === distRoot || filePath.startsWith(`${distRoot}${sep}`)

  if (!insideDist) {
    sendJson(response, 403, { error: 'Forbidden' })
    return
  }

  try {
    if (!(await stat(filePath)).isFile()) throw new Error('Not a file')
  } catch {
    filePath = resolve(distRoot, 'index.html')
  }

  try {
    const body = await readFile(filePath)
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch {
    sendJson(response, 404, { error: 'Build output not found. Run npm run build first.' })
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? HTTP_HOST}`)

  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    })
    response.write(`event: ready\ndata: ${JSON.stringify({ port: transport.listenPort })}\n\n`)
    sseClients.add(response)

    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000)
    heartbeat.unref()
    request.on('close', () => {
      clearInterval(heartbeat)
      sseClients.delete(response)
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      osc: 'ready',
      listenPort: transport.listenPort,
      lanAddresses: getLanAddresses(),
      sequence: sequence
        ? { id: sequence.id, title: sequence.title, durationMs: sequence.durationMs }
        : null,
    })
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/listener') {
    try {
      const body = await readJson(request) as Record<string, unknown>
      const port = integer(body?.port, 'Listening port', 1, 65535)
      await transport.listen(port)
      sendJson(response, 200, { ok: true, port, lanAddresses: getLanAddresses() })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Unable to change listening port' })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/transmit') {
    try {
      const settings = validateTransmitRequest(await readJson(request))
      const result = transmit(settings)
      console.log(`[osc] sent ${result.address} [${result.noteOn.join(', ')}] -> ${result.destination}`)
      sendJson(response, 202, result)
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid request' })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sequence') {
    try {
      const settings = validateSequenceRequest(await readJson(request))
      sendJson(response, 202, startSequence(settings))
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid MIDI sequence' })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/sequence/stop') {
    sendJson(response, 200, { ok: true, stopped: stopSequence('stopped') })
    return
  }

  if (serveStatic && (request.method === 'GET' || request.method === 'HEAD')) {
    await serveBuiltApp(request, response, url.pathname)
    return
  }

  sendJson(response, 404, { error: 'Not found' })
})

server.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[bridge] listening on http://${HTTP_HOST}:${HTTP_PORT}`)
  if (serveStatic) console.log(`[app] serving the production build from ${distRoot}`)
})

function shutdown(): void {
  stopSequence('shutdown')
  for (const client of sseClients) client.end()
  server.close(() => {
    transport.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
