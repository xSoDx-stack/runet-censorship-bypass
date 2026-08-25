module.exports = {
  extends: ['eslint:recommended'],
  env: {
    browser: true,
    webextensions: true,
    es2022: true,
    node: true,
  },
  globals: {
    chrome: true,
  },
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 2022,
  },
  rules: {
    'no-console': 'off',
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-empty': ['warn', { allowEmptyCatch: true }],
  },
};
