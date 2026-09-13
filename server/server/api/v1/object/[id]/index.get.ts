import aclManager from "~/server/internal/acls";
import objectHandler from "~/server/internal/objects";
import sanitize from "sanitize-filename";

export default defineEventHandler(async (h3) => {
  const unsafeId = getRouterParam(h3, "id");
  if (!unsafeId)
    throw createError({ statusCode: 400, statusMessage: "Invalid ID" });

  const userId = await aclManager.getUserIdACL(h3, ["object:read"]);

  const id = sanitize(unsafeId);
  const permission = await objectHandler.checkPermission(id, userId);
  if (!permission)
    throw createError({ statusCode: 404, statusMessage: "Object not found" });

  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag
  const etagRequestValue = h3.headers.get("If-None-Match");
  const etagActualValue = await objectHandler.fetchHash(id);

  setHeader(h3, "ETag", etagActualValue ?? "");
  setHeader(h3, "Content-Type", permission.mime);
  setHeader(
    h3,
    "Cache-Control",
    "private, max-age=31536000, s-maxage=31536000, immutable",
  );

  if (
    etagRequestValue &&
    etagActualValue &&
    etagActualValue === etagRequestValue
  ) {
    // would compare if etag is valid, but objects should never change
    setResponseStatus(h3, 304);
    return null;
  }

  const source = await objectHandler.fetch(id);
  if (!source)
    throw createError({ statusCode: 404, statusMessage: "Object not found" });

  return source;
});
