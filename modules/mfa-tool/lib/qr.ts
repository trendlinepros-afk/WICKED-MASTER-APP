/**
 * Decode QR codes out of an image file — the port of qr_decode.py.
 *
 * The Python tool used pyzbar/OpenCV; here the image is drawn to a canvas and
 * scanned with `jsqr`. Deviation: jsQR finds at most ONE code per image (the
 * Python decoders could return several), so multi-code screenshots should be
 * imported as one image per code.
 */

import jsQR from 'jsqr'

/** Return the text payload of the QR code in `file` (empty array if none). */
export async function decodeImageFile(file: Blob): Promise<string[]> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const result = jsQR(image.data, image.width, image.height, {
      inversionAttempts: 'attemptBoth'
    })
    return result && result.data ? [result.data] : []
  } finally {
    bitmap.close()
  }
}
