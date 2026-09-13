// Shared ESLint flat-config blocks for every Drop workspace.
//
// These are local equivalents of the SonarCloud rules the remote quality gate
// enforces. They are deliberately curated (not the plugins' full `recommended`
// sets) so every rule maps to a finding class we actually triage on
// SonarCloud. Consume with:
//
//   import shared from "../../eslint.config.shared.mjs";
//   export default [...shared];
import eslintConfigPrettier from "eslint-config-prettier/flat";
import sonarjs from "eslint-plugin-sonarjs";
import regexpPlugin from "eslint-plugin-regexp";
import unicorn from "eslint-plugin-unicorn";
import vueA11y from "eslint-plugin-vuejs-accessibility";

export default [
  eslintConfigPrettier,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,tsx,vue}"],
    plugins: {
      sonarjs,
      regexp: regexpPlugin,
      unicorn,
    },
    rules: {
      // Sonar S3776 / S4624 / S3626 / S1940 / S1066
      "sonarjs/cognitive-complexity": ["error", 15],
      // S1192 (duplicate literals) is intentionally not enabled: the remote
      // SonarCloud TypeScript profile does not enable it, and it flags i18n
      // keys and test names that are deliberately repeated.
      "sonarjs/no-nested-template-literals": "error",
      "sonarjs/no-redundant-jump": "error",
      "sonarjs/no-inverted-boolean-check": "error",
      "sonarjs/no-collapsible-if": "error",
      "sonarjs/no-identical-functions": "error",

      // Sonar S8786 / S5869 (ReDoS and duplicate character classes)
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-dupe-characters-character-class": "error",

      // Sonar modernization cluster: S7773, S7752, S7754, S7753, S7784, S7780,
      // S7758, S7776, S7765, S7772, S7785, S7766
      "unicorn/prefer-number-properties": "error",
      "unicorn/prefer-array-flat-map": "error",
      "unicorn/prefer-array-some": "error",
      "unicorn/prefer-array-index-of": "error",
      "unicorn/prefer-structured-clone": "error",
      "unicorn/prefer-string-raw": "error",
      "unicorn/prefer-code-point": "error",
      "unicorn/prefer-set-has": "error",
      "unicorn/prefer-includes": "error",
      "unicorn/prefer-node-protocol": "error",
      "unicorn/prefer-top-level-await": "error",
      "unicorn/prefer-math-min-max": "error",

      // Sonar S6582 (prefer optional chaining) is intentionally not enabled:
      // @typescript-eslint/prefer-optional-chain needs type-aware linting,
      // which the workspace flat configs do not enable repo-wide.
    },
  },
  {
    files: ["**/*.vue"],
    plugins: {
      "vue-a11y": vueA11y,
    },
    rules: {
      // Sonar web accessibility cluster (alt text, keyboard access, labels)
      "vue-a11y/alt-text": "error",
      "vue-a11y/click-events-have-key-events": "error",
      "vue-a11y/no-static-element-interactions": "error",
      "vue-a11y/form-control-has-label": "error",
    },
  },
];
