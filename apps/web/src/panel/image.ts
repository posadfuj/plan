/**
 * Prepara el logo en el navegador antes de subirlo: las fotos del celular pesan varios MB (y en iPhone
 * pueden ser HEIC). Se dibuja en un canvas de máximo 512 px y se exporta como PNG (conserva la
 * transparencia) o, si aún pesa mucho, como JPEG. La API vuelve a validar tipo y tamaño.
 */
const MAX_SIDE = 512;
const TARGET_BYTES = 600 * 1024;

async function decode(file: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* Safari antiguo o formato raro: se intenta con <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export async function prepareLogo(file: File): Promise<Blob> {
  let img;
  try {
    img = await decode(file);
  } catch {
    throw new Error('No pudimos leer esa imagen. Usa una foto o un archivo PNG o JPG.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Tu navegador no pudo procesar la imagen.');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const png = await toBlob(canvas, 'image/png');
  if (png && png.size <= TARGET_BYTES) return png;
  const jpg = await toBlob(canvas, 'image/jpeg', 0.88);
  if (!jpg) throw new Error('Tu navegador no pudo procesar la imagen.');
  return jpg;
}
