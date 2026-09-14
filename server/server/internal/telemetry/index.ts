import prisma from "../db/database";
import { TelemetryManager, type TelemetryDeps } from "./manager";

const deps: TelemetryDeps = {
  prisma: prisma as unknown as TelemetryDeps["prisma"],
};

export const telemetryManager = new TelemetryManager(deps);
export { TelemetryManager };
export * from "./manager";
export default telemetryManager;
