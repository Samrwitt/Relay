const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const dt =
    (date.getSeconds() >> 1) |
    (date.getMinutes() << 5) |
    (date.getHours() << 11);
  const dd =
    date.getDate() |
    ((date.getMonth() + 1) << 5) |
    ((date.getFullYear() - 1980) << 9);
  return { time: dt, date: dd };
}

function uniqueName(name, used) {
  const baseName = String(name || "file").replace(/\\/g, "/").split("/").pop() || "file";
  if (!used.has(baseName)) {
    used.add(baseName);
    return baseName;
  }
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : "";
  let i = 2;
  let next = `${stem} (${i})${ext}`;
  while (used.has(next)) {
    i += 1;
    next = `${stem} (${i})${ext}`;
  }
  used.add(next);
  return next;
}

export async function zipFiles(files) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime();
  const parts = [];
  const centrals = [];
  const used = new Set();
  let offset = 0;

  for (const file of files) {
    if (!file?.blob) continue;
    const name = uniqueName(file.name, used);
    const nameBytes = encoder.encode(name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(data);
    const size = data.byteLength;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    parts.push(local, data);
    centrals.push(central);
    offset += local.length + size;
  }

  const dirStart = offset;
  for (const c of centrals) {
    parts.push(c);
    offset += c.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, offset - dirStart, true);
  ev.setUint32(16, dirStart, true);
  parts.push(eocd);

  return new Blob(parts, { type: "application/zip" });
}
