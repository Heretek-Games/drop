import prisma from "../db/database";
import { PresenceManager, type PresenceDeps } from "./manager";

const deps: PresenceDeps = {
  prisma: prisma as unknown as PresenceDeps["prisma"],
};

export const presenceManager = new PresenceManager(deps);
export { PresenceManager };
export * from "./manager";
export default presenceManager;
