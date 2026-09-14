import prisma from "../db/database";
import { applicationSettings } from "../config/application-configuration";
import objectHandler from "../objects";
import { SaveManager, type SaveManagerDeps } from "./manager";

const deps: SaveManagerDeps = {
  prisma: prisma as unknown as SaveManagerDeps["prisma"],
  objectHandler: objectHandler as unknown as SaveManagerDeps["objectHandler"],
  settings: applicationSettings as unknown as SaveManagerDeps["settings"],
};

export const saveManager = new SaveManager(deps);
export { SaveManager };
export type { SaveManagerDeps, SaveSlotRecord } from "./manager";
export default saveManager;
