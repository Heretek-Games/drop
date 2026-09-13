import { ArkErrors, type } from "arktype";
import type { SerializeObject } from "nitropack";
import type { Prisma } from "~/prisma/client/client";
import aclManager from "~/server/internal/acls";
import prisma from "~/server/internal/db/database";
import libraryManager from "~/server/internal/library";
import deepmerge from "deepmerge";

const Query = type({
  query: "string?",
  skip: "string.numeric.parse?",
  limit: "string.numeric.parse?",

  sort: "'default' | 'newest' | 'recent' | 'name' = 'default'",
  order: "'asc' | 'desc' = 'desc'",

  "filters?": type("string").pipe((s) => s.split(",")),
});

type FetchArg = Parameters<typeof libraryManager.fetchGamesWithStatus>[0];

const FILTER_BUILDERS: Record<
  string,
  Prisma.GameFindManyArgs & Prisma.GameCountArgs
> = {
  "version.none": {
    where: {
      versions: {
        none: {},
      },
    },
  },
  "metadata.featured": {
    where: {
      featured: true,
    },
  },
  "metadata.noCarousel": {
    where: {
      OR: [
        {
          mImageCarouselObjectIds: {
            isEmpty: true,
          },
        },
      ],
    },
  },
  "metadata.emptyDescription": {
    where: {
      mDescription: "",
    },
  },
};

function buildRawFilters(
  filters: string[] | undefined,
  search: string | undefined,
): Array<Prisma.GameFindManyArgs & Prisma.GameCountArgs> {
  const rawFilters: Array<Prisma.GameFindManyArgs & Prisma.GameCountArgs> = [];

  for (const filter of new Set(filters ?? [])) {
    const builder = FILTER_BUILDERS[filter];
    if (builder) {
      rawFilters.push(builder);
    }
  }

  if (search) {
    rawFilters.push({
      where: {
        mName: {
          contains: search,
          mode: "insensitive",
        },
      },
    });
  }

  return rawFilters;
}

export type AdminLibraryGame = SerializeObject<
  Awaited<ReturnType<typeof libraryManager.fetchGamesWithStatus>>[number]
>;

export default defineEventHandler(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, ["library:read"]);
  if (!allowed) throw createError({ statusCode: 403 });

  const query = Query(getQuery(h3));
  if (query instanceof ArkErrors)
    throw createError({ statusCode: 400, message: query.summary });

  const skip = query.skip
    ? ({
        skip: query.skip,
      } satisfies FetchArg)
    : undefined;

  const limit = Math.min(query.limit ?? 24, 50);

  const sort: Prisma.GameOrderByWithRelationInput = {};
  switch (query.sort) {
    case "default":
    case "newest":
      sort.mReleased = query.order;
      break;
    case "recent":
      sort.created = query.order;
      break;
    case "name":
      sort.mName = query.order;
      break;
  }

  const rawFilters = buildRawFilters(query.filters, query.query);

  const filters =
    rawFilters.length > 0
      ? rawFilters.reduce((a, b) => deepmerge(a, b), {})
      : undefined;

  const results = await libraryManager.fetchGamesWithStatus({
    ...skip,
    take: limit,
    orderBy: sort,
    ...filters,
  });

  // Safety: the type is defined as a union between the where and count args
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const count = await prisma.game.count({ ...(filters as any) });

  return { results, count };
});
