import { globalIgnores } from "eslint/config";
import eslintPluginAstro from "eslint-plugin-astro";
import shared from "../../eslint.config.shared.mjs";

export default [
  globalIgnores(["dist/**", ".astro/**", "node_modules/**"]),
  ...eslintPluginAstro.configs["flat/recommended"],
  ...shared,
];
