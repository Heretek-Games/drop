// @ts-nocheck -- composes untyped shared JS config with the generated Nuxt config
import withNuxt from "./.playground/.nuxt/eslint.config.mjs";
import shared from "../../eslint.config.shared.mjs";

export default withNuxt(shared);
