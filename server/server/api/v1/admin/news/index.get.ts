import { defineEventHandler, getQuery } from "h3";
import aclManager from "~/server/internal/acls";
import newsManager from "~/server/internal/news";
import { parseNewsQuery } from "~/server/internal/news/query";

export default defineEventHandler(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, ["news:read"]);
  if (!allowed)
    throw createError({
      statusCode: 403,
    });

  const query = getQuery(h3);

  const options = parseNewsQuery(query);

  const news = await newsManager.fetch(options);
  return news;
});
