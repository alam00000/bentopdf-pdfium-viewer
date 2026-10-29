const IMAGE_NAME = /\.(png|jpe?g|jpe|jfif|gif|bmp|dib|webp|avif|svg|ico|tiff?)$/i;
const JPEG_NAME = /\.(jpe?g|jpe|jfif)$/i;
const MAX_PIXELS = 16_777_216;

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function isImageFile(file: File): boolean {
  return !isPdfFile(file) && (file.type.startsWith('image/') || IMAGE_NAME.test(file.name));
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: File): Promise<Decoded | null> {
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => {} };
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface EncodedImage {
  width: number;
  height: number;
  filter: 'DCTDecode' | 'FlateDecode';
  data: Uint8Array<ArrayBuffer>;
  mask: Uint8Array<ArrayBuffer> | null;
}

async function encode(file: File, decoded: Decoded): Promise<EncodedImage | null> {
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (decoded.width * decoded.height)));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const jpeg = file.type === 'image/jpeg' || JPEG_NAME.test(file.name);
  if (jpeg) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(decoded.source, 0, 0, width, height);
  if (jpeg) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.95),
    );
    if (!blob) return null;
    return {
      width,
      height,
      filter: 'DCTDecode',
      data: new Uint8Array(await blob.arrayBuffer()),
      mask: null,
    };
  }
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let translucent = false;
  for (let i = 0, p = 0; p < alpha.length; i += 4, p++) {
    rgb[p * 3] = rgba[i]!;
    rgb[p * 3 + 1] = rgba[i + 1]!;
    rgb[p * 3 + 2] = rgba[i + 2]!;
    alpha[p] = rgba[i + 3]!;
    if (alpha[p] !== 255) translucent = true;
  }
  return {
    width,
    height,
    filter: 'FlateDecode',
    data: await deflate(rgb),
    mask: translucent ? await deflate(alpha) : null,
  };
}

function writePdf(pageWidth: number, pageHeight: number, image: EncodedImage): ArrayBuffer {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (body: string, stream?: Uint8Array) => {
    offsets.push(length);
    push(`${offsets.length} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };
  const content = encoder.encode(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`);
  const imageDict = (colorSpace: string, filter: string, size: number, extra = '') =>
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${colorSpace} /BitsPerComponent 8 /Filter /${filter} /Length ${size}${extra} >>`;

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  );
  object(
    imageDict('DeviceRGB', image.filter, image.data.length, image.mask ? ' /SMask 6 0 R' : ''),
    image.data,
  );
  object(`<< /Length ${content.length} >>`, content);
  if (image.mask) object(imageDict('DeviceGray', 'FlateDecode', image.mask.length), image.mask);

  const xref = length;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out.buffer;
}

export async function imageFileToPdf(file: File): Promise<ArrayBuffer | null> {
  const decoded = await decode(file);
  if (!decoded) return null;
  try {
    if (!(decoded.width > 0) || !(decoded.height > 0)) return null;
    const image = await encode(file, decoded);
    return image ? writePdf(decoded.width, decoded.height, image) : null;
  } catch {
    return null;
  } finally {
    decoded.release();
  }
}
