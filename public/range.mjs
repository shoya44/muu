// null: ignore the Range header and serve the entire representation.
export function parseRange(header, size) {
  if (!header || !header.startsWith('bytes=') || header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return { invalid: true };
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return { invalid: true };
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

// Read bounded chunks instead of converting every cached MP3 into an ArrayBuffer.
export function sliceStream(body, start, end) {
  const reader = body.getReader();
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) { controller.error(new Error('Truncated cached media')); return; }
          const next = offset + value.byteLength;
          if (next > start) {
            controller.enqueue(value.subarray(Math.max(0, start - offset), Math.min(value.byteLength, end + 1 - offset)));
          }
          offset = next;
          if (offset > end) { controller.close(); await reader.cancel(); return; }
          if (offset > start) return;
        }
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
