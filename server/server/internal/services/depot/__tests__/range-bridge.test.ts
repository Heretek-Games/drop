import test from "node:test";
import assert from "node:assert/strict";
import {
  getTorrentialRpcSecret,
  verifyTorrentialRpcSecret,
} from "../../torrential";
import pluginManager from "../../../plugins";
import type { PluginContext, ServerPlugin } from "../../../plugins/types";
import handler from "~/server/api/v1/internal/depot/[gameId]/[depotId]/range.get";

test("verifyTorrentialRpcSecret validates constant-time hex secret", () => {
  const current = getTorrentialRpcSecret();
  assert.equal(verifyTorrentialRpcSecret(current), true);
  assert.equal(verifyTorrentialRpcSecret(current.toUpperCase()), true);
  assert.equal(verifyTorrentialRpcSecret("bad-secret"), false);
  assert.equal(verifyTorrentialRpcSecret("0".repeat(64)), false);
  assert.equal(verifyTorrentialRpcSecret(null), false);
  assert.equal(verifyTorrentialRpcSecret(undefined), false);
});

function mockEvent(options: {
  headers?: Record<string, string>;
  remoteAddress?: string;
  params?: Record<string, string>;
  url?: string;
}) {
  const headers = new Map<string, string>(
    Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const urlObj = new URL(
    options.url ?? "http://localhost/api/v1/internal/depot/test/depot/range",
  );

  const responseHeaders: Record<string, string> = {};
  const statusCode = 200;

  const path = urlObj.pathname + urlObj.search;

  return {
    path,
    node: {
      req: {
        headers: Object.fromEntries(headers.entries()),
        socket: {
          remoteAddress: options.remoteAddress ?? "127.0.0.1",
        },
        url: path,
      },
      res: {
        statusCode,
        setHeader: (k: string, v: string) => {
          responseHeaders[k.toLowerCase()] = v;
        },
      },
    },
    context: {
      params: options.params ?? {},
    },
    _responseHeaders: responseHeaders,
    _getStatusCode: () => statusCode,
  } as unknown as Parameters<typeof handler>[0];
}

type H3Error = { statusCode?: number };

function assertStatus(expected: number) {
  return (err: unknown): boolean => {
    assert.equal((err as H3Error).statusCode, expected);
    return true;
  };
}

test("bridge rejects missing or invalid x-torrential-secret", async () => {
  const event = mockEvent({
    headers: {},
    params: { gameId: "g1", depotId: "d1" },
  });

  await assert.rejects(async () => handler(event), assertStatus(401));

  const eventBad = mockEvent({
    headers: { "x-torrential-secret": "wrong" },
    params: { gameId: "g1", depotId: "d1" },
  });

  await assert.rejects(async () => handler(eventBad), assertStatus(401));
});

test("bridge rejects non-loopback peer IP", async () => {
  const secret = getTorrentialRpcSecret();
  const event = mockEvent({
    headers: { "x-torrential-secret": secret },
    remoteAddress: "192.168.1.105",
    params: { gameId: "g1", depotId: "d1" },
  });

  await assert.rejects(async () => handler(event), assertStatus(403));
});

test("bridge handles pieceReader byte range requests over loopback", async () => {
  const secret = getTorrentialRpcSecret();
  const mockPlugin = {
    metadata: {
      id: "mock-bridge-plugin",
      name: "Mock Bridge Plugin",
      version: "1.0.0",
      author: "Test",
      apiVersion: 3,
      entry: "index.js",
      capabilities: ["storage:depot"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerDepotProvider!({
        id: "mock-bridge-provider",
        name: "Mock Bridge",
        resolveDepotStream: async (depotId: string, gameId: string) => {
          if (gameId === "game-42" && depotId === "depot-99") {
            return {
              pieceReader: async (offset: number, length: number) => {
                const buf = new Uint8Array(length);
                for (let i = 0; i < length; i++) {
                  buf[i] = (offset + i) % 256;
                }
                return buf;
              },
            };
          }
          return null;
        },
      });
    },
  };

  await pluginManager.registerPlugin(mockPlugin as ServerPlugin);

  try {
    const event = mockEvent({
      headers: {
        "x-torrential-secret": secret,
        range: "bytes=10-14",
      },
      remoteAddress: "127.0.0.1",
      params: { gameId: "game-42", depotId: "depot-99" },
    });

    const result = await handler(event);
    assert.ok(result instanceof Buffer);
    assert.equal(result.length, 5);
    assert.deepEqual([...result], [10, 11, 12, 13, 14]);

    // Check query params offset/length fallback
    const queryEvent = mockEvent({
      headers: {
        "x-torrential-secret": secret,
      },
      remoteAddress: "127.0.0.1",
      params: { gameId: "game-42", depotId: "depot-99" },
      url: "http://localhost/api/v1/internal/depot/game-42/depot-99/range?offset=50&length=3",
    });

    const queryResult = await handler(queryEvent);
    assert.ok(queryResult instanceof Buffer);
    assert.equal(queryResult.length, 3);
    assert.deepEqual([...queryResult], [50, 51, 52]);
  } finally {
    await pluginManager.unregisterPlugin("mock-bridge-plugin");
  }
});
