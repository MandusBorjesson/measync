import {
  GLOBAL_COLORS,
  LINE_CENTER,
  LINE_GLOBAL_MAX,
  LINE_GLOBAL_MIN,
  type ThermalSeries,
  type ThermalZone,
  zoneColor,
  zoneLineId,
} from '../thermal'
import type { GraphLine } from '../graph'
import { GraphPlot } from './GraphPlot'
import type { Viewport } from '../viewport'

type Props = {
  series: ThermalSeries
  zones: ThermalZone[]
  t0: number | null
  t1: number | null
  center: number | null
  live: boolean
  lockFront?: boolean
  lockBack?: boolean
  duration?: number
  rangeMin?: number | null
  rangeMax?: number | null
  onScrub?: (next: Viewport) => void
  hidden: Record<string, boolean>
  onToggle: (id: string) => void
}

function linesFor(series: ThermalSeries, zones: ThermalZone[]): GraphLine[] {
  const lines: GraphLine[] = [
    {
      id: LINE_GLOBAL_MAX,
      label: 'global max',
      color: GLOBAL_COLORS.max,
      unit: '°C',
      mean: series.max.mean,
      min: series.max.min,
      max: series.max.max,
    },
    {
      id: LINE_CENTER,
      label: 'center',
      color: GLOBAL_COLORS.center,
      unit: '°C',
      mean: series.center.mean,
      min: series.center.min,
      max: series.center.max,
    },
    {
      id: LINE_GLOBAL_MIN,
      label: 'global min',
      color: GLOBAL_COLORS.min,
      unit: '°C',
      mean: series.min.mean,
      min: series.min.min,
      max: series.min.max,
    },
  ]
  zones.forEach((zone, i) => {
    const data = series.zones[i]
    const color = zoneColor(zone, i)
    lines.push({
      id: zoneLineId(zone.id, 'max'),
      label: `${zone.name} max`,
      color,
      unit: '°C',
      mean: data?.max.mean ?? [],
      min: data?.max.min ?? [],
      max: data?.max.max ?? [],
    })
    lines.push({
      id: zoneLineId(zone.id, 'min'),
      label: `${zone.name} min`,
      color,
      unit: '°C',
      dashed: true,
      mean: data?.min.mean ?? [],
      min: data?.min.min ?? [],
      max: data?.min.max ?? [],
    })
  })
  return lines
}

export function ThermalGraph({
  series,
  zones,
  t0,
  t1,
  center,
  live,
  lockFront = false,
  lockBack = false,
  duration,
  rangeMin,
  rangeMax,
  onScrub,
  hidden,
  onToggle,
}: Props) {
  return (
    <GraphPlot
      t={series.t}
      lines={linesFor(series, zones)}
      t0={t0}
      t1={t1}
      center={center}
      live={live}
      lockFront={lockFront}
      lockBack={lockBack}
      duration={duration}
      rangeMin={rangeMin}
      rangeMax={rangeMax}
      onScrub={onScrub}
      hidden={hidden}
      onToggle={onToggle}
      sampleDots={!!series.raw}
      yLabel="°C"
      emptyHint="global min / max / center · drag a zone on the image"
      formatTick={(value) => value.toFixed(1)}
    />
  )
}
