import { fetchPcm } from './api'

const CHUNK_NS = 2_000_000_000

let shared: AudioContext | null = null

function context() {
  if (!shared) shared = new AudioContext()
  return shared
}

export function unlockAudio() {
  const ctx = context()
  return ctx.state === 'suspended' ? ctx.resume() : Promise.resolve()
}

export function playCaptureAudio(sourceId: string, fromNs: number, toNs: number, rate: number) {
  const ctx = context()
  const ac = new AbortController()
  const nodes: AudioBufferSourceNode[] = []
  const speed = Math.max(0.25, Math.min(8, rate))

  void (async () => {
    await ctx.resume()
    const originCtx = ctx.currentTime + 0.04
    let cursor = fromNs
    while (!ac.signal.aborted && cursor < toNs) {
      const end = Math.min(cursor + CHUNK_NS, toNs)
      let sampleRate = 44100
      let samples = new Float32Array(0)
      try {
        const next = await fetchPcm(sourceId, cursor, end, ac.signal)
        sampleRate = next.sampleRate
        samples = new Float32Array(next.samples)
      } catch {
        break
      }
      if (ac.signal.aborted) return
      if (samples.length === 0) {
        cursor = end
        continue
      }
      const hz = sampleRate >= 8000 && sampleRate <= 192_000 ? sampleRate : 44100
      const buf = ctx.createBuffer(1, samples.length, hz)
      buf.copyToChannel(samples, 0)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = speed
      src.connect(ctx.destination)
      const when = originCtx + (cursor - fromNs) / 1e9 / speed
      const late = ctx.currentTime - when
      if (late > buf.duration / speed) {
        cursor = end
        continue
      }
      if (late > 0) src.start(ctx.currentTime, late * speed)
      else src.start(when)
      nodes.push(src)
      cursor = end
      const ahead = originCtx + (cursor - fromNs) / 1e9 / speed - ctx.currentTime
      if (ahead > 0.7) {
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(400, (ahead - 0.35) * 1000)))
      }
    }
  })()

  return () => {
    ac.abort()
    for (const node of nodes) {
      try {
        node.stop()
      } catch {
        /* already finished */
      }
      node.disconnect()
    }
  }
}
