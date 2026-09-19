import type { ThermalSeries, ThermalZone } from './types'
import { emptyBand } from './graph'

export type { ThermalSeries, ThermalZone }

export const SENSOR_W = 256
export const SENSOR_H = 192
export const MAX_ZONES = 6
export const DEFAULT_SPLIT = 0.62

export const GLOBAL_COLORS = {
  min: '#7fdbff',
  max: '#ffd166',
  center: '#e7edf5',
} as const

export const ZONE_COLORS = ['#2ec4b6', '#7dce82', '#c084fc', '#5ad4ff', '#ff8fab', '#f0a202']

export const LINE_GLOBAL_MAX = 'global-max'
export const LINE_GLOBAL_MIN = 'global-min'
export const LINE_CENTER = 'center'

export function zoneLineId(zoneId: string, kind: 'min' | 'max') {
  return `${zoneId}:${kind}`
}

export type ThermalStats = {
  minC: number | null
  maxC: number | null
  centerC: number | null
  minX: number | null
  minY: number | null
  maxX: number | null
  maxY: number | null
}

export type ZoneStats = {
  minC: number
  maxC: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const EMPTY_STATS: ThermalStats = {
  minC: null,
  maxC: null,
  centerC: null,
  minX: null,
  minY: null,
  maxX: null,
  maxY: null,
}

export const EMPTY_SERIES: ThermalSeries = {
  t: [],
  min: emptyBand(),
  max: emptyBand(),
  center: emptyBand(),
  zones: [],
  raw: false,
}

export type FrameBox = { left: number; top: number; width: number; height: number }

function isJpegAt(bytes: Uint8Array, offset: number) {
  return bytes.length >= offset + 2 && bytes[offset] === 0xff && bytes[offset + 1] === 0xd8
}

function isThrm(bytes: Uint8Array) {
  return bytes.length >= 16 && bytes[0] === 0x54 && bytes[1] === 0x48 && bytes[2] === 0x52 && bytes[3] === 0x4d
}

function readHeaderStats(view: DataView): Pick<ThermalStats, 'minC' | 'maxC' | 'centerC'> & {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  return {
    minC: view.getFloat32(4, true),
    maxC: view.getFloat32(8, true),
    centerC: view.getFloat32(12, true),
    minX: view.getUint16(16, true),
    minY: view.getUint16(18, true),
    maxX: view.getUint16(20, true),
    maxY: view.getUint16(22, true),
  }
}

async function inflateTemps(bytes: Uint8Array): Promise<Float32Array | null> {
  if (typeof DecompressionStream === 'undefined') return null
  try {
    const copy = bytes.slice()
    const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('deflate'))
    const buffer = await new Response(stream).arrayBuffer()
    if (buffer.byteLength !== SENSOR_W * SENSOR_H * 2) return null
    const centi = new Int16Array(buffer)
    const out = new Float32Array(centi.length)
    for (let i = 0; i < centi.length; i++) out[i] = centi[i] / 100
    return out
  } catch {
    return null
  }
}

export function parseThermalSnapshot(buffer: ArrayBuffer): {
  jpeg: ArrayBuffer
  stats: ThermalStats
  tempBytes: Uint8Array | null
} {
  const bytes = new Uint8Array(buffer)
  if (!isThrm(bytes)) {
    return { jpeg: buffer, stats: EMPTY_STATS, tempBytes: null }
  }
  const view = new DataView(buffer)
  const v2 = 32
  if (bytes.length >= v2 + 2) {
    const jpegLen = view.getUint32(24, true)
    const tempLen = view.getUint32(28, true)
    const jpegOff = v2
    if (jpegLen >= 2 && jpegOff + jpegLen <= bytes.length && isJpegAt(bytes, jpegOff)) {
      const stats = { ...EMPTY_STATS, ...readHeaderStats(view) }
      const jpeg = buffer.slice(jpegOff, jpegOff + jpegLen)
      const tempStart = jpegOff + jpegLen
      const tempEnd = Math.min(bytes.length, tempStart + Math.max(0, tempLen))
      const tempBytes = tempEnd > tempStart ? bytes.slice(tempStart, tempEnd) : null
      return { jpeg, stats, tempBytes }
    }
  }
  if (isJpegAt(bytes, 24)) {
    return {
      jpeg: buffer.slice(24),
      stats: { ...EMPTY_STATS, ...readHeaderStats(view) },
      tempBytes: null,
    }
  }
  if (isJpegAt(bytes, 16)) {
    return {
      jpeg: buffer.slice(16),
      stats: {
        ...EMPTY_STATS,
        minC: view.getFloat32(4, true),
        maxC: view.getFloat32(8, true),
        centerC: view.getFloat32(12, true),
      },
      tempBytes: null,
    }
  }
  return { jpeg: buffer, stats: EMPTY_STATS, tempBytes: null }
}

export async function decodeTempMap(bytes: Uint8Array): Promise<Float32Array | null> {
  return inflateTemps(bytes)
}

export function formatC(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}°C`
}

export function measureFrame(img: HTMLImageElement): FrameBox | null {
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  const cw = img.clientWidth
  const ch = img.clientHeight
  if (!nw || !nh || !cw || !ch) return null
  const scale = Math.min(cw / nw, ch / nh)
  const width = nw * scale
  const height = nh * scale
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height }
}

export function spotStyle(box: FrameBox, sx: number, sy: number) {
  return {
    left: box.left + ((sx + 0.5) / SENSOR_W) * box.width,
    top: box.top + ((sy + 0.5) / SENSOR_H) * box.height,
  }
}

export function zoneBoxStyle(box: FrameBox, zone: ThermalZone) {
  return {
    left: box.left + (zone.x / SENSOR_W) * box.width,
    top: box.top + (zone.y / SENSOR_H) * box.height,
    width: (zone.w / SENSOR_W) * box.width,
    height: (zone.h / SENSOR_H) * box.height,
  }
}

export function clientToSensor(box: FrameBox, localX: number, localY: number) {
  const sx = ((localX - box.left) / box.width) * SENSOR_W
  const sy = ((localY - box.top) / box.height) * SENSOR_H
  return {
    x: Math.max(0, Math.min(SENSOR_W - 1, Math.floor(sx))),
    y: Math.max(0, Math.min(SENSOR_H - 1, Math.floor(sy))),
  }
}

export function clampZone(x: number, y: number, w: number, h: number): ThermalZone {
  const x0 = Math.max(0, Math.min(SENSOR_W - 1, Math.min(x, x + w)))
  const y0 = Math.max(0, Math.min(SENSOR_H - 1, Math.min(y, y + h)))
  const x1 = Math.max(x0 + 1, Math.min(SENSOR_W, Math.max(x, x + w)))
  const y1 = Math.max(y0 + 1, Math.min(SENSOR_H, Math.max(y, y + h)))
  return { id: '', name: '', x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function moveZone(zone: ThermalZone, dx: number, dy: number): ThermalZone {
  return {
    ...zone,
    x: Math.max(0, Math.min(SENSOR_W - zone.w, zone.x + dx)),
    y: Math.max(0, Math.min(SENSOR_H - zone.h, zone.y + dy)),
  }
}

export function zoneColor(zone: ThermalZone, index: number) {
  const numbered = /^Z(\d+)$/.exec(zone.name)
  if (numbered) {
    const n = Number(numbered[1])
    if (n > 0) return ZONE_COLORS[(n - 1) % ZONE_COLORS.length]
  }
  return ZONE_COLORS[index % ZONE_COLORS.length]
}

export function nextZoneName(zones: ThermalZone[]) {
  const used = new Set(zones.map((z) => z.name))
  for (let i = 1; i <= MAX_ZONES; i++) {
    const name = `Z${i}`
    if (!used.has(name)) return name
  }
  return `Z${zones.length + 1}`
}

export function encodeZoneQuery(zones: ThermalZone[]) {
  return zones.map((z) => `${z.x},${z.y},${z.w},${z.h}`).join(';')
}

export function zoneExtrema(temp: Float32Array, zone: ThermalZone): ZoneStats | null {
  const x0 = Math.max(0, Math.min(SENSOR_W - 1, zone.x))
  const y0 = Math.max(0, Math.min(SENSOR_H - 1, zone.y))
  const x1 = Math.max(x0 + 1, Math.min(SENSOR_W, x0 + Math.max(1, zone.w)))
  const y1 = Math.max(y0 + 1, Math.min(SENSOR_H, y0 + Math.max(1, zone.h)))
  let minC = Number.POSITIVE_INFINITY
  let maxC = Number.NEGATIVE_INFINITY
  let minX = x0
  let minY = y0
  let maxX = x0
  let maxY = y0
  for (let y = y0; y < y1; y++) {
    const row = y * SENSOR_W
    for (let x = x0; x < x1; x++) {
      const v = temp[row + x]
      if (v < minC) {
        minC = v
        minX = x
        minY = y
      }
      if (v > maxC) {
        maxC = v
        maxX = x
        maxY = y
      }
    }
  }
  if (!Number.isFinite(minC) || !Number.isFinite(maxC)) return null
  return { minC, maxC, minX, minY, maxX, maxY }
}
