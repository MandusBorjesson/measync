import type { Device, Profile, SavedCapture, SessionStatus, ThermalSeries, Waveform } from './types'

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') return body.detail
    return JSON.stringify(body.detail ?? body)
  } catch {
    return res.statusText
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await parseError(res))
  return res.json() as Promise<T>
}

export async function fetchDevices(): Promise<Device[]> {
  const data = await json<{ devices: Device[] }>(await fetch('/api/devices'))
  return data.devices
}

export async function fetchSession(): Promise<SessionStatus> {
  return json<SessionStatus>(await fetch('/api/session'))
}

export async function startRecording(): Promise<SessionStatus> {
  return json<SessionStatus>(await fetch('/api/session/start', { method: 'POST' }))
}

export async function stopRecording(): Promise<SessionStatus> {
  return json<SessionStatus>(await fetch('/api/session/stop', { method: 'POST' }))
}

export async function setCap(bytes_cap: number): Promise<SessionStatus> {
  return json<SessionStatus>(
    await fetch('/api/session/cap', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes_cap }),
    }),
  )
}

export async function startSource(sourceId: string): Promise<void> {
  await json(await fetch(`/api/sources/${encodeURIComponent(sourceId)}`, { method: 'POST' }))
}

export async function stopSource(sourceId: string): Promise<void> {
  await json(await fetch(`/api/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' }))
}

export async function fetchThermalSeries(
  sourceId: string,
  t0: number,
  t1: number,
  zones: { x: number; y: number; w: number; h: number }[] = [],
): Promise<ThermalSeries> {
  const q = new URLSearchParams({ t0: String(Math.round(t0)), t1: String(Math.round(t1)) })
  if (zones.length) {
    q.set('zones', zones.map((z) => `${z.x},${z.y},${z.w},${z.h}`).join(';'))
  }
  return json<ThermalSeries>(
    await fetch(`/api/session/thermal/${encodeURIComponent(sourceId)}/series?${q}`),
  )
}

export async function fetchWaveform(sourceId: string, t0: number, t1: number): Promise<Waveform> {
  const q = new URLSearchParams({ t0: String(Math.round(t0)), t1: String(Math.round(t1)) })
  return json<Waveform>(
    await fetch(`/api/session/audio/${encodeURIComponent(sourceId)}/waveform?${q}`),
  )
}

export function frameUrl(sourceId: string, t: number): string {
  return `/api/session/camera/${encodeURIComponent(sourceId)}/frame?t=${Math.round(t)}`
}

export async function fetchFrame(sourceId: string, t: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(frameUrl(sourceId, t), { signal })
  if (!res.ok) throw new Error(await parseError(res))
  return res.arrayBuffer()
}

export function thermalFrameUrl(sourceId: string, t: number): string {
  return `/api/session/thermal/${encodeURIComponent(sourceId)}/frame?t=${Math.round(t)}`
}

export async function fetchThermalFrame(sourceId: string, t: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(thermalFrameUrl(sourceId, t), { signal })
  if (!res.ok) throw new Error(await parseError(res))
  return res.arrayBuffer()
}

export async function fetchPcm(
  sourceId: string,
  t0: number,
  t1: number,
  signal?: AbortSignal,
): Promise<{ sampleRate: number; samples: Float32Array }> {
  const q = new URLSearchParams({ t0: String(Math.round(t0)), t1: String(Math.round(t1)) })
  const res = await fetch(`/api/session/audio/${encodeURIComponent(sourceId)}/pcm?${q}`, { signal })
  if (!res.ok) throw new Error(await parseError(res))
  const sampleRate = Number(res.headers.get('X-Sample-Rate') || 44100)
  const buffer = await res.arrayBuffer()
  return { sampleRate, samples: new Float32Array(buffer) }
}

export async function listProfiles(): Promise<{ name: string }[]> {
  const data = await json<{ profiles: { name: string }[] }>(await fetch('/api/profiles'))
  return data.profiles
}

export async function loadProfile(name: string): Promise<Profile> {
  return json<Profile>(await fetch(`/api/profiles/${encodeURIComponent(name)}`))
}

export async function saveProfile(profile: Profile): Promise<void> {
  await json(
    await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    }),
  )
}

export async function deleteProfile(name: string): Promise<void> {
  await json(await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }))
}

export async function listCaptures(): Promise<SavedCapture[]> {
  const data = await json<{ captures: SavedCapture[] }>(await fetch('/api/captures'))
  return data.captures
}

export async function saveCapture(name: string): Promise<void> {
  await json(
    await fetch('/api/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
}

export async function openCapture(name: string): Promise<SessionStatus> {
  return json<SessionStatus>(
    await fetch(`/api/captures/${encodeURIComponent(name)}/open`, { method: 'POST' }),
  )
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}
