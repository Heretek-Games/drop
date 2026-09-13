import aclManager from "~/server/internal/acls";
import taskHandler from "~/server/internal/tasks";

export default defineEventHandler(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, ["import:game:new"]);
  if (!allowed) throw createError({ statusCode: 403 });

  const taskId = await taskHandler.runTaskGroupByName("import:discover");
  if (!taskId)
    throw createError({
      statusCode: 500,
      statusMessage: "Could not start discovery task.",
    });

  return { taskId };
});
