import fs from "node:fs";
import process from "node:process";
import { spawn as crossSpawn } from "cross-spawn";
import createLogger from "pino";

const OUTPUT = "./.output";
const logger = createLogger({ transport: { target: "pino-pretty" } });

// cross-spawn avoids `shell: true` on POSIX and resolves Windows shims (e.g.
// pnpm.cmd) without an interpolating shell.
async function spawn(exec, args = [], opts = {}) {
  const output = crossSpawn(exec, args, { ...opts, shell: false });
  output.stdout.on("data", (data) => {
    process.stdout.write(data);
  });
  output.stderr.on("data", (data) => {
    process.stderr.write(data);
  });

  return await new Promise((resolve, reject) => {
    output.on("error", (err) => reject(err));
    output.on("exit", () => resolve());
  });
}

const views = fs.readdirSync(".").filter((view) => {
  const expectedPath = `./${view}/package.json`;
  return fs.existsSync(expectedPath);
});

fs.mkdirSync(OUTPUT, { recursive: true });

for (const view of views) {
  const loggerChild = logger.child({});
  process.chdir(`./${view}`);

  loggerChild.info(`Install deps for "${view}"`);
  await spawn("pnpm", ["install"]);

  loggerChild.info(`Building "${view}"`);
  await spawn("pnpm", ["run", "build"], {
    env: { ...process.env, NUXT_APP_BASE_URL: `/${view}/` },
  });

  process.chdir("..");

  fs.cpSync(`./${view}/.output/public`, `${OUTPUT}/${view}`, {
    recursive: true,
  });
}
