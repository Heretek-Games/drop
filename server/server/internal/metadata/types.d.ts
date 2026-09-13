import type { Company, GameRating } from "~/prisma/client/client";
import type { AgeRatingOrganization } from "~/prisma/client/enums";
import type { TransactionDataType } from "../objects/transactional";

export interface GameMetadataSearchResult {
  id: string;
  name: string;
  icon: string;
  description: string;
  year: number;
}

export interface GameMetadataSource {
  sourceId: string;
  sourceName: string;
}

export type InternalGameMetadataResult = GameMetadataSearchResult &
  GameMetadataSource;

export type GameMetadataRating = Pick<
  GameRating,
  | "metadataSource"
  | "metadataId"
  | "mReviewCount"
  | "mReviewHref"
  | "mReviewRating"
>;

export interface GameMetadataAgeRating {
  organization: AgeRatingOrganization;
  rating: string;
  ratingCoverUrl?: string;
}

export interface GameMetadata {
  id: string;
  name: string;
  shortDescription: string;
  description: string;
  released: Date;

  // These are created using utility functions passed to the metadata loader
  // (that then call back into the metadata provider chain)
  publishers: Company[];
  developers: Company[];

  tags: string[];

  reviews: GameMetadataRating[];
  ageRatings: GameMetadataAgeRating[];

  // Created with another utility function
  icon: string;
  bannerId: string;
  coverId: string;
  images: string[];
}

export interface CompanyMetadata {
  id: string;
  name: string;
  shortDescription: string;
  description: string;

  logo: string;
  banner: string;
  website: string;
}

export interface _FetchGameMetadataParams {
  id: string;
  name: string;

  company: (query: string) => Promise<Company | undefined>;

  createObject: (data: TransactionDataType) => string;
}

export interface _FetchCompanyMetadataParams {
  query: string;
  createObject: (data: TransactionDataType) => string;
}
