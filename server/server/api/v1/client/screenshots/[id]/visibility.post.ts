import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import screenshotManager from "~/server/internal/screenshots";

interface VisibilityBody {
  private?: boolean;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const id = getRouterParam(h3, "id");
  if (!id)
    throw createError({
      statusCode: 400,
      statusMessage: "screenshot id is required",
    });

  const screenshot = await screenshotManager.get(id);
  if (!screenshot || screenshot.userId !== user.id) {
    throw createError({ statusCode: 404, statusMessage: "Unknown screenshot" });
  }

  const body = ((await readBody<VisibilityBody>(h3)) ?? {}) as VisibilityBody;
  if (typeof body.private !== "boolean") {
    throw createError({
      statusCode: 400,
      statusMessage: "private must be a boolean",
    });
  }

  const ok = await screenshotManager.setVisibility(id, body.private);
  return { success: ok, private: body.private };
});
