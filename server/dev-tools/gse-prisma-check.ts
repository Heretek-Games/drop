/**
 * Integration check for the drop-gse Prisma persistence.
 *
 * Requires DATABASE_URL pointing at a migrated Drop database:
 *   DATABASE_URL=postgres://drop:drop@localhost:5432/drop \
 *     pnpm exec jiti dev-tools/gse-prisma-check.ts
 */
import { InMemoryMeshBackend } from "../server/internal/plugins/builtin/gse/mesh";
import { PrismaRoomPersistence } from "../server/internal/plugins/builtin/gse/prisma-persistence";
import { RoomStore } from "../server/internal/plugins/builtin/gse/room-store";

const store = new RoomStore(
  new PrismaRoomPersistence(),
  new InMemoryMeshBackend(),
);

const room = await store.create({
  gameId: "game-prisma-check",
  versionId: "v1",
  appId: 480,
  emulator: { flavor: "gbe_fork", release: "latest", releaseDigest: "d" },
  hostUserId: "user-1",
});
console.log("created", room.id, room.appId);

const credential = await store.credential(room.id, "user-1");
console.log("credential", credential.address, credential.secret);

const joined = await store.join(room.id, "user-2");
console.log("members", joined.members.length);

const listed = await store.list();
console.log("listed", listed.length, listed[0]?.appId);

const closed = await store.leave(room.id, "user-1");
const after = await store.list();
console.log("closed", closed.closed, "remaining", after.length);
if (!closed.closed || after.length !== 0) {
  throw new Error("Prisma persistence did not persist/delete correctly");
}

console.log("OK");
