import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [".next/**", ".vercel/**", "node_modules/**"],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
];

export default config;
