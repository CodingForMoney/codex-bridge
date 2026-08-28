import { BridgeError } from "../errors.js";

export async function pipeOpaqueCompactResponse(
  body: ReadableStream<Uint8Array> | null,
  write: (chunk: Uint8Array) => boolean,
  waitForDrain: () => Promise<boolean>,
  signal: AbortSignal
): Promise<void> {
  if (!body) {
    throw new BridgeError(
      "PROTOCOL_RESPONSE_INVALID",
      "Codex compact response did not contain a JSON body.",
      { statusCode: 502 }
    );
  }

  const reader = body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) {
    cancel();
  } else {
    signal.addEventListener("abort", cancel, { once: true });
  }
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (!write(value) && !(await waitForDrain())) {
        cancel();
        return;
      }
    }
    cancel();
  } finally {
    signal.removeEventListener("abort", cancel);
    if (cancellation) {
      await cancellation;
    }
    reader.releaseLock();
  }
}
