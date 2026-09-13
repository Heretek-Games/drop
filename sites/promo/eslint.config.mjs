import coreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import shared from '../../eslint.config.shared.mjs'

const eslintConfig = [
  ...coreWebVitals,
  ...nextTs,
  {
    rules: {
      '@next/next/no-img-element': 'off',
      'prefer-const': 'off',
    },
  },
  ...shared,
]

export default eslintConfig
