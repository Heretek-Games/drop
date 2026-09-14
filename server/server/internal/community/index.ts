import prisma from "../db/database";
import { ReviewManager, type ReviewDeps } from "./manager";
import { ForumManager, type ForumDeps } from "./forum";

const deps: ReviewDeps = {
  prisma: prisma as unknown as ReviewDeps["prisma"],
};

const forumDeps: ForumDeps = {
  prisma: prisma as unknown as ForumDeps["prisma"],
};

export const reviewManager = new ReviewManager(deps);
export const forumManager = new ForumManager(forumDeps);
export {
  ReviewManager,
  DEFAULT_VERIFIED_PLAYTIME_SECONDS,
  isVerifiedReview,
} from "./manager";
export type { ReviewDeps, ReviewRecord } from "./manager";
export {
  ForumManager,
  MAX_POST_LENGTH,
  MAX_THREAD_TITLE_LENGTH,
} from "./forum";
export type { ForumDeps, ForumPostRecord, ForumThreadRecord } from "./forum";
export default reviewManager;
