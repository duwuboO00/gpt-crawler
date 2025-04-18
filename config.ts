import { Config } from "./src/config";

export const defaultConfig: Config = {
  url: "https://www.builder.io/c/docs/developers",
  match: "https://www.builder.io/c/docs/**",
  // selector: "article",
  maxPagesToCrawl: 500,
  outputFileName: "output.json",
  maxTokens: 200000000,
};
