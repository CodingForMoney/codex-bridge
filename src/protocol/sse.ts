import { BridgeError } from "../errors.js";

export interface SseEvent {
  event?: string;
  data: string;
}

const MAX_EVENT_BYTES = 16 * 1024 * 1024;

export async function* parseSseStream(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SseEvent> {
  if (!body) {
    throw new BridgeError("PROTOCOL_RESPONSE_INVALID", "Codex response did not contain a stream body.", {
      statusCode: 502
    });
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES) {
        throw new BridgeError("PROTOCOL_RESPONSE_INVALID", "Codex returned an oversized SSE event.", {
          statusCode: 502
        });
      }
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) {
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        break;
      }
    }
    const trailing = parseFrame(buffer.trim());
    if (trailing) {
      yield trailing;
    }
  } finally {
    reader.releaseLock();
  }
}

export function encodeSse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function parseFrame(frame: string): SseEvent | undefined {
  if (!frame || frame.startsWith(":")) {
    return undefined;
  }
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  return { ...(event ? { event } : {}), data: data.join("\n") };
}
