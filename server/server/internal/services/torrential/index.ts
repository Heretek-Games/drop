import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Service } from "..";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../../logging";
import type { Socket } from "node:net";
import net from "node:net";
import { create, toBinary, type Message } from "@bufbuild/protobuf";
import { fromBinary } from "@bufbuild/protobuf";
import { StringValueSchema } from "@bufbuild/protobuf/wkt";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import {
  DropBoundSchema,
  TorrentialBoundSchema,
  TorrentialBoundType,
  type DropBound,
  type DropBoundType,
} from "../../proto/torrential/proto/core_pb";

/// Processors
import manifestFetchProcessor from "./manifest-fetch";
import serverGamesProcessor from "./server-games";

const INTERNAL_DEPOT_URL = new URL(
  process.env.INTERNAL_DEPOT_URL ?? "http://localhost:5000",
);

/**
 * Spawn-time secret shared with the torrential RPC listener. Torrential
 * refuses unauthenticated peers, so the process we spawn (or the separately
 * configured one) must know this value. An operator running torrential outside
 * this process must set `TORRENTIAL_RPC_SECRET` on both sides.
 */
function resolveRpcSecret(): string {
  const provided = process.env.TORRENTIAL_RPC_SECRET?.trim();
  if (provided) {
    if (!/^[0-9a-fA-F]{64}$/.test(provided)) {
      throw new Error("TORRENTIAL_RPC_SECRET must be 64 hex characters");
    }
    return provided.toLowerCase();
  }
  return randomBytes(32).toString("hex");
}

const RPC_SECRET = resolveRpcSecret();

const TORRENTIAL_SPAWN_ENV = {
  ...process.env,
  TORRENTIAL_RPC_SECRET: RPC_SECRET,
};

export interface QueryProcessor<
  T extends DropBoundType,
  K extends TorrentialBoundType,
  V extends Message,
> {
  queryType: T;
  run: (
    query: DropBound,
  ) => Promise<{ type: K; schema: GenMessage<V>; data: V } | undefined>;
}

export class TorrentialService extends Service<unknown> {
  private socket: Socket | undefined;
  private readbuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readingQueue = false;

  private readonly queryProcessors: Map<
    DropBoundType,
    QueryProcessor<DropBoundType, TorrentialBoundType, Message>
  > = new Map();

  constructor() {
    super(
      "torrential",
      () => {
        const torrentialDir = "../torrential";
        if (fs.existsSync(torrentialDir)) {
          const stat = fs.statSync(torrentialDir);
          if (stat.isDirectory()) {
            // in dev and we have the submodule
            logger.info(
              "torrential detected in development mode - building from source",
            );
            return spawn(
              "cargo", // NOSONAR: dev-only path; the binary is a fixed literal and the server environment is trusted
              [
                "run",
                "--manifest-path",
                `${torrentialDir}/Cargo.toml`,
                "--release",
              ],
              { env: TORRENTIAL_SPAWN_ENV },
            );
          }
        }

        // Resolve the binary to an absolute path instead of searching PATH:
        // a user-writable directory on PATH could otherwise hijack the spawn.
        // The Docker image installs it at /usr/bin/torrential.
        const candidates = [
          process.env.TORRENTIAL_PATH,
          path.join(process.cwd(), "torrential"),
          "/usr/local/bin/torrential",
          "/usr/bin/torrential",
        ].filter((candidate): candidate is string => Boolean(candidate));
        for (const candidate of candidates) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return spawn(candidate, [], { env: TORRENTIAL_SPAWN_ENV });
          }
        }

        throw new Error(
          "torrential binary not found; set TORRENTIAL_PATH or place 'torrential' in the working directory",
        );
      },
      async () => {
        const socket = net.createConnection({ port: 33148, host: "127.0.0.1" });
        await new Promise<void>((r, j) => {
          socket.on("connect", () => {
            // Authenticate before torrential will send any RPC query.
            socket.write(Buffer.from(RPC_SECRET, "hex"));
            this.logger.info("connected to torrential socket");
            this.socket = socket;
            r();
          });
          socket.on("error", (err) => j(err));
        });

        this.setupRead();
        return true;
      },
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      async () => await $fetch(`${INTERNAL_DEPOT_URL.toString()}healthcheck`),
      {},
    );

    this.queryProcessors.set(
      manifestFetchProcessor.queryType,
      manifestFetchProcessor,
    );
    this.queryProcessors.set(
      serverGamesProcessor.queryType,
      serverGamesProcessor,
    );
  }

  registerProcessor(
    processor: QueryProcessor<DropBoundType, TorrentialBoundType, Message>,
  ) {
    this.queryProcessors.set(processor.queryType, processor);
  }

  private setupRead() {
    if (!this.socket) return;
    this.socket.on("data", (data) => {
      this.readbuf = Buffer.concat([this.readbuf, data]);
      if (!this.readingQueue) {
        this.readingQueue = true;
        this.queueRead().finally(() => {
          this.readingQueue = false;
        });
      }
    });
  }

  async writeMessage<T extends Message>(
    messageId: string,
    value: {
      type: TorrentialBoundType;
      schema: GenMessage<T>;
      data: T;
    },
  ) {
    if (!this.socket) throw new Error("Not connected to torrential");

    const response = create(TorrentialBoundSchema, {
      messageId: messageId,
      type: value.type,
      data: toBinary(value.schema, value.data),
    });

    const responseBinary = toBinary(TorrentialBoundSchema, response);
    const responseLength = responseBinary.length;

    const responseLengthBuf = Buffer.allocUnsafe(8);
    responseLengthBuf.writeBigUInt64LE(BigInt(responseLength), 0);

    this.socket!.write(responseLengthBuf);
    this.socket!.write(responseBinary);
  }

  private async queueRead() {
    if (!this.socket) throw new Error("Not connected to torrential");
    if (this.readbuf.length < 8) return;
    const sizeBytes = this.readbuf.subarray(0, 8);
    const size = sizeBytes.readBigUInt64LE(0);
    const end = Number(size + BigInt(8));
    if (this.readbuf.length < end) return;

    const buffer = this.readbuf.subarray(8, end);
    this.readbuf = this.readbuf.subarray(end);
    const query = fromBinary(DropBoundSchema, buffer);
    const processor = this.queryProcessors.get(query.type);
    if (!processor) {
      this.logger.warn(`no processor for query type: ${query.type}`);
      return;
    }

    let value;

    try {
      value = await processor.run(query);
    } catch (e) {
      this.logger.warn(
        `process query for ${query.type} failed with error: ${e}`,
      );
      value = {
        type: TorrentialBoundType.ERROR,
        schema: StringValueSchema,
        data: create(StringValueSchema, {
          value: (e as string).toString(),
        }),
      };
    }

    if (value) await this.writeMessage(query.messageId, value);

    // Call until we can't
    await this.queueRead();
  }
}

export const TORRENTIAL_SERVICE = new TorrentialService();
export default TORRENTIAL_SERVICE;
