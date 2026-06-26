module.exports = {
  root: true,
  extends: ["@repo/config/eslint-preset"],
  parserOptions: {
    project: true,
  },
  settings: {
    next: {
      rootDir: ["apps/web"],
    },
  },
  ignorePatterns: [
    "node_modules/",
    "dist/",
    ".next/",
    "coverage/",
    "*.config.js",
    "*.config.ts",
  ],
};
