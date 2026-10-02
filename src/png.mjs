// Read image dimensions from PNG/JPEG/WebP/GIF bytes without dependencies.

export function imageDimensions(buffer) {
  if (!buffer || buffer.length < 16) return null;

  // PNG: \x89PNG\r\n\x1a\n then IHDR width/height (big-endian uint32 at 16/20)
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", little-endian uint16
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { format: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // WebP: "RIFF"…"WEBP"
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    const fourcc = buffer.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      const w = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const h = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return { format: 'webp', width: w, height: h };
    }
    if (fourcc === 'VP8 ' && buffer.length >= 30) {
      return { format: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { format: 'webp', width: null, height: null };
  }

  // JPEG: walk segments looking for a Start-Of-Frame marker
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const size = buffer.readUInt16BE(offset + 2);
      const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
                    (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        return { format: 'jpeg', width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
    return { format: 'jpeg', width: null, height: null };
  }

  return null;
}