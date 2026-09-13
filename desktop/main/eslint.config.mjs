// @ts-nocheck -- composes untyped shared JS config with typed Nuxt configs
import withNuxt from "./.nuxt/eslint.config.mjs";
import shared from "../../eslint.config.shared.mjs";

export default withNuxt([
  ...shared,
  {
    rules: {
      // Vue 3 supports fragment roots and intentionally empty templates
      // (redirect/quit pages); these rules are Vue 2 era.
      "vue/no-multiple-template-root": "off",
      "vue/valid-template-root": "off",
      // Nuxt page/layout/route filenames are inherently single-word.
      "vue/multi-word-component-names": "off",
    },
  },
]);
