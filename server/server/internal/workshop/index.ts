import prisma from "../db/database";
import { WorkshopManager, type WorkshopDeps } from "./manager";

const deps: WorkshopDeps = {
  prisma: prisma as unknown as WorkshopDeps["prisma"],
};

export const workshopManager = new WorkshopManager(deps);
export { WorkshopManager };
export * from "./manifest";
export * from "./manager";
export default workshopManager;
