import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import newsManager from "~/server/internal/news";

export default defineClientEventHandler(async (h3) => {
  const query = getQuery(h3);

  const orderBy = query.order as "asc" | "desc";
  if (
    orderBy &&
    (typeof orderBy !== "string" || !["asc", "desc"].includes(orderBy))
  )
    throw createError({ statusCode: 400, statusMessage: "Invalid order" });

  const tags = query.tags as string[] | undefined;
  if (tags && (typeof tags !== "object" || !Array.isArray(tags)))
    throw createError({ statusCode: 400, statusMessage: "Invalid tags" });

  const options = {
    take: Number.parseInt(query.limit as string),
    skip: Number.parseInt(query.skip as string),
    orderBy: orderBy,
    ...(tags && { tags: tags.map((e) => e.toString()) }),
    search: query.search as string,
  };

  const news = await newsManager.fetch(options);
  return news;
});
