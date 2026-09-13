import { createError } from "h3";

export interface NewsQueryOptions {
  take: number;
  skip: number;
  orderBy?: "asc" | "desc";
  tags?: string[];
  search?: string;
}

/**
 * Parses and validates the query parameters shared by the public, admin and
 * client news endpoints. Throws a 400 when `order` or `tags` are malformed.
 */
export function parseNewsQuery(
  query: Record<string, unknown>,
): NewsQueryOptions {
  const orderBy = query.order as "asc" | "desc";
  if (
    orderBy &&
    (typeof orderBy !== "string" || !["asc", "desc"].includes(orderBy))
  )
    throw createError({ statusCode: 400, statusMessage: "Invalid order" });

  const tags = query.tags as string[] | undefined;
  if (tags && (typeof tags !== "object" || !Array.isArray(tags)))
    throw createError({ statusCode: 400, statusMessage: "Invalid tags" });

  const search = query.search as string | undefined;

  return {
    take: Number.parseInt(query.limit as string),
    skip: Number.parseInt(query.skip as string),
    ...(orderBy && { orderBy }),
    ...(tags && { tags: tags.map((e) => e.toString()) }),
    ...(search && { search }),
  };
}
