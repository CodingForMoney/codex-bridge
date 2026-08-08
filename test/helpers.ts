import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature"
  ].join(".");
}

export async function writeCodexAuth(
  codexHome: string,
  options: { accessToken?: string; accountId?: string; expiresAt?: number } = {}
): Promise<string> {
  await mkdir(codexHome, { recursive: true });
  const accessToken = options.accessToken ?? jwt({
    exp: options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: options.accountId ?? "account-1" }
  });
  const file = path.join(codexHome, "auth.json");
  await writeFile(file, JSON.stringify({ tokens: { access_token: accessToken } }), "utf8");
  return accessToken;
}

export function codexSse(events: unknown[]): Response {
  const body = events.map((event) => `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function completeTextEvents(text = "hello", id = "resp_1"): unknown[] {
  return [
    { type: "response.created", response: { id } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "message_1",
        role: "assistant",
        content: [{ type: "output_text", text }]
      }
    },
    {
      type: "response.completed",
      response: {
        id,
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }
        }
      }
    }
  ];
}
