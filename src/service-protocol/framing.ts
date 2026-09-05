import { MAX_FRAME_BYTES } from "./v1-registry.js";

export type FramingErrorCode = "PARSE_ERROR" | "INVALID_REQUEST" | "MESSAGE_TOO_LARGE";

export class FramingError extends Error {
  constructor(readonly symbolicCode: FramingErrorCode) {
    super(symbolicCode);
    this.name = "FramingError";
  }
}

export class NdjsonFramer {
  #pending = Buffer.alloc(0);
  #closed = false;

  push(chunk: Uint8Array): readonly unknown[] {
    if (this.#closed) throw new FramingError("INVALID_REQUEST");
    const input = Buffer.from(chunk);
    const records: unknown[] = [];
    let offset = 0;
    while (offset < input.length) {
      const newline = input.indexOf(0x0a, offset);
      if (newline === -1) {
        const tail = input.subarray(offset);
        if (this.#pending.length + tail.length >= MAX_FRAME_BYTES) throw new FramingError("MESSAGE_TOO_LARGE");
        this.#pending = this.#pending.length === 0 ? Buffer.from(tail) : Buffer.concat([this.#pending, tail]);
        break;
      }
      const segment = input.subarray(offset, newline);
      if (this.#pending.length + segment.length + 1 > MAX_FRAME_BYTES) throw new FramingError("MESSAGE_TOO_LARGE");
      const frame = this.#pending.length === 0 ? Buffer.from(segment) : Buffer.concat([this.#pending, segment]);
      this.#pending = Buffer.alloc(0);
      records.push(this.#parse(frame));
      offset = newline + 1;
    }
    return records;
  }

  end(): void {
    this.#closed = true;
    if (this.#pending.length !== 0) throw new FramingError("INVALID_REQUEST");
  }

  #parse(bytes: Buffer): unknown {
    if (bytes.length === 0 || bytes.includes(0x0d)) throw new FramingError("INVALID_REQUEST");
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new FramingError("INVALID_REQUEST");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new FramingError("PARSE_ERROR"); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new FramingError("PARSE_ERROR"); }
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FramingError("INVALID_REQUEST");
    return value;
  }
}

export function encodeFrame(value: unknown): Buffer {
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { throw new FramingError("INVALID_REQUEST"); }
  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new FramingError("MESSAGE_TOO_LARGE");
  return bytes;
}
