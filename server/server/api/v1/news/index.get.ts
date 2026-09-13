import { defineEventHandler, getQuery } from "h3";
import aclManager from "~/server/internal/acls";
import newsManager from "~/server/internal/news";
import { parseNewsQuery } from "~/server/internal/news/query";

export default defineEventHandler(async (h3) => {
  const userId = await aclManager.getUserIdACL(h3, ["news:read"]);
  if (!userId)
    throw createError({
      statusCode: 403,
      statusMessage: "Requires authentication",
    });

  const query = getQuery(h3);

  const options = parseNewsQuery(query);

  const news = await newsManager.fetch(options);
  return news;
});
