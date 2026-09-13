// Formats and auto-fixes files right after opencode edits them, using the same
// shared script as the Claude/Cursor hooks. Best-effort: failures never block.
export const QualityPlugin = async ({ $, directory }) => {
  const root = directory ?? process.cwd();
  return {
    "tool.execute.after": async (input, output) => {
      const tool = input?.tool;
      if (tool !== "edit" && tool !== "write") return;

      const file =
        output?.args?.filePath ??
        input?.args?.filePath ??
        output?.args?.path ??
        input?.args?.path;
      if (typeof file !== "string" || file.length === 0) return;

      try {
        await $`bash ${root}/scripts/agent-quality.sh ${file}`
          .quiet()
          .nothrow();
      } catch {
        // Formatting is advisory; never surface a failure to the model.
      }
    },
  };
};

export default QualityPlugin;
