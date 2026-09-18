import type { Layout, SplitDir } from './types'

export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom'

export function findFirstLeaf(layout: Layout): string {
  if (layout.type === 'leaf') return layout.id
  return findFirstLeaf(layout.first)
}

export function collectLeaves(layout: Layout | null): string[] {
  if (!layout) return []
  if (layout.type === 'leaf') return [layout.id]
  return [...collectLeaves(layout.first), ...collectLeaves(layout.second)]
}

export function containsLeaf(layout: Layout, id: string): boolean {
  if (layout.type === 'leaf') return layout.id === id
  return containsLeaf(layout.first, id) || containsLeaf(layout.second, id)
}

export function addLeaf(
  layout: Layout | null,
  focusedId: string | null,
  newId: string,
  dir: SplitDir,
): Layout {
  if (!layout) return { type: 'leaf', id: newId }
  const target = focusedId && containsLeaf(layout, focusedId) ? focusedId : findFirstLeaf(layout)
  return splitLeaf(layout, target, newId, dir)
}

function splitLeaf(node: Layout, targetId: string, newId: string, dir: SplitDir): Layout {
  if (node.type === 'leaf') {
    if (node.id !== targetId) return node
    return {
      type: 'split',
      direction: dir,
      ratio: 0.5,
      first: node,
      second: { type: 'leaf', id: newId },
    }
  }
  return {
    ...node,
    first: splitLeaf(node.first, targetId, newId, dir),
    second: splitLeaf(node.second, targetId, newId, dir),
  }
}

export function splitExisting(layout: Layout, targetId: string, newId: string, dir: SplitDir): Layout {
  return splitLeaf(layout, targetId, newId, dir)
}

export function removeLeaf(layout: Layout, id: string): Layout | null {
  if (layout.type === 'leaf') return layout.id === id ? null : layout
  const first = removeLeaf(layout.first, id)
  const second = removeLeaf(layout.second, id)
  if (!first) return second
  if (!second) return first
  return { ...layout, first, second }
}

export function setRatio(layout: Layout, pathKey: string, ratio: number): Layout {
  return setRatioAt(layout, pathKey, ratio, 'root')
}

function setRatioAt(node: Layout, pathKey: string, ratio: number, here: string): Layout {
  if (node.type === 'leaf') return node
  if (here === pathKey) {
    return { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) }
  }
  return {
    ...node,
    first: setRatioAt(node.first, pathKey, ratio, `${here}.first`),
    second: setRatioAt(node.second, pathKey, ratio, `${here}.second`),
  }
}

export function dropZoneAt(clientX: number, clientY: number, rect: DOMRect): DropZone {
  const x = (clientX - rect.left) / Math.max(1, rect.width)
  const y = (clientY - rect.top) / Math.max(1, rect.height)
  const edge = 0.28
  const distLeft = x
  const distRight = 1 - x
  const distTop = y
  const distBottom = 1 - y
  const nearest = Math.min(distLeft, distRight, distTop, distBottom)
  if (nearest > edge) return 'center'
  if (nearest === distLeft) return 'left'
  if (nearest === distRight) return 'right'
  if (nearest === distTop) return 'top'
  return 'bottom'
}

function swapLeaves(node: Layout, a: string, b: string): Layout {
  if (node.type === 'leaf') {
    if (node.id === a) return { ...node, id: b }
    if (node.id === b) return { ...node, id: a }
    return node
  }
  return { ...node, first: swapLeaves(node.first, a, b), second: swapLeaves(node.second, a, b) }
}

function insertBeside(
  node: Layout,
  targetId: string,
  incoming: Layout,
  dir: SplitDir,
  incomingFirst: boolean,
): Layout {
  if (node.type === 'leaf') {
    if (node.id !== targetId) return node
    return {
      type: 'split',
      direction: dir,
      ratio: 0.5,
      first: incomingFirst ? incoming : node,
      second: incomingFirst ? node : incoming,
    }
  }
  return {
    ...node,
    first: insertBeside(node.first, targetId, incoming, dir, incomingFirst),
    second: insertBeside(node.second, targetId, incoming, dir, incomingFirst),
  }
}

export function relocateLeaf(layout: Layout, fromId: string, toId: string, zone: DropZone): Layout {
  if (fromId === toId) return layout
  if (zone === 'center') return swapLeaves(layout, fromId, toId)
  const rest = removeLeaf(layout, fromId)
  if (!rest) return layout
  const dir: SplitDir = zone === 'left' || zone === 'right' ? 'h' : 'v'
  const incomingFirst = zone === 'left' || zone === 'top'
  return insertBeside(rest, toId, { type: 'leaf', id: fromId }, dir, incomingFirst)
}
