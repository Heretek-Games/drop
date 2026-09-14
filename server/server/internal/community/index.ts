import prisma from "../db/database";
import { ReviewManager, type ReviewDeps } from "./manager";

const deps: ReviewDeps = {
  prisma: prisma as unknown as ReviewDeps["prisma"],
};

export const reviewManager = new ReviewManager(deps);
export {
  ReviewManager,
  DEFAULT_VERIFIED_PLAYTIME_SECONDS,
  isVerifiedReview,
} from "./manager";
export type { ReviewDeps, ReviewRecord } from "./manager";
export default reviewManager;
