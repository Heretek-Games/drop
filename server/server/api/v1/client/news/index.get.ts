import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import newsManager from "~/server/internal/news";
import { parseNewsQuery } from "~/server/internal/news/query";

export default defineClientEventHandler(async (h3) => {
  const query = getQuery(h3);

  const options = parseNewsQuery(query);

  const news = await newsManager.fetch(options);
  return news;
});
