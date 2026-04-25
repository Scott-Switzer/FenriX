import { useEffect, useRef } from 'react'
import { gridToImageData, type SpriteData } from './sprite-data'

interface Props {
  data: SpriteData
  frame: number
  /** Optional className for positioning. */
  className?: string
}

/**
 * Renders one frame of a SpriteData to a native-pixel <canvas>. The canvas
 * is sized at `data.width × data.height` (no scaling here — the parent
 * scene container CSS-scales all layers uniformly).
 *
 * `image-rendering: pixelated` is set inline so the canvas draws crisp
 * pixels even when CSS scales the ancestor.
 */
export function PixelSprite({ data, frame, className }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const image = gridToImageData(data, frame)
    const imageData = new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.putImageData(imageData, 0, 0)
  }, [data, frame])

  return (
    <canvas
      ref={ref}
      width={data.width}
      height={data.height}
      className={className}
      style={{ imageRendering: 'pixelated', display: 'block' }}
    />
  )
}
