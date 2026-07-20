import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Ops one-off scripts / CJS / tmp are not product surface — lint gates on src/.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "scripts/**",
    "**/*.cjs",
    "data/**",
    "docs/**",
    "tmp-*.json",
  ]),
]);

export default eslintConfig;
