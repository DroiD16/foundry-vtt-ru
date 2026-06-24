import { defineConfig } from "vite-plus";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";

const CORE_ONLY_EXCLUDES = [
  "compendium",
  "fonts",
  "styles",
  "i18n/modules",
  "i18n/systems",
  "i18n/core/adjectives_f.json",
  "images/alien",
];

export default defineConfig({
  plugins: [
    {
      name: "core-only-package",
      async closeBundle() {
        await Promise.all(
          CORE_ONLY_EXCLUDES.map((path) =>
            rm(resolve("ru-ru", path), { force: true, recursive: true }),
          ),
        );
      },
    },
  ],
  staged: {
    "*.{js,ts,tsx,css,json}": "vp check --fix",
  },
  build: {
    lib: {
      entry: "src/index.js",
      formats: ["es"],
      name: "ru-ru",
    },
    emptyOutDir: true,
    minify: "oxc",
    outDir: "ru-ru",
    rolldownOptions: {
      external: ["../../babele/script/converters.js"],
      output: {
        chunkFileNames: "esm/[name].js",
        entryFileNames: "esm/[name].js",
      },
    },
    sourcemap: false,
  },
  fmt: {
    quoteProps: "consistent",
    singleAttributePerLine: true,
    endOfLine: "lf",
    // Defaults:
    // "arrowParens": "always",
    // "bracketSpacing": true,
    // "indentStyle": "space",
    // "indentWidth": 2,
    // "printWidth": 100,
    // "semi": true,
    // "singleQuote": false,
    // "trailingComma": "all"
    // "useTabs": false,
  },
  lint: {
    categories: {
      correctness: "error",
      pedantic: "off",
      perf: "warn",
      restriction: "warn",
      style: "warn",
      suspicious: "warn",
    },
    env: {
      browser: true,
      node: false,
    },
    options: {
      typeAware: false,
      typeCheck: false,
    },
    plugins: ["oxc"],
    rules: {
      "eslint/func-style": "off",
      "eslint/id-length": "off",
      "eslint/init-declarations": "off",
      "eslint/max-statements": "off",
      "eslint/no-magic-numbers": "off",
      "eslint/sort-keys": "off",
      "eslint/no-underscore-dangle": "off",
      "no-console": "off",
      "no-process-exit": "off",
      "oxc/no-async-await": "off",
      "oxc/no-optional-chaining": "off",
      "oxc/no-rest-spread-properties": "off",
    },
  },
});
