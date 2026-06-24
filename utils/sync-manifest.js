import { readFile, writeFile } from "node:fs/promises";

const CORE_LANGUAGES = [
  {
    lang: "ru",
    name: "Russian",
    path: "i18n/core/foundry.json",
  },
  {
    lang: "ru",
    path: "i18n/core/extras.json",
  },
  {
    lang: "ru",
    path: "i18n/core/adjectives_m.json",
  },
];

async function main() {
  const manifestPath = "./public/module.json";
  const manifestData = JSON.parse(await readFile(manifestPath, "utf8"));

  manifestData.styles = [];
  manifestData.languages = CORE_LANGUAGES;
  delete manifestData.relationships;
  delete manifestData.flags.styles;
  manifestData.flags.hotReload = {
    enabled: true,
    extensions: ["json"],
    paths: ["i18n/core/*.json"],
  };

  await writeFile(manifestPath, `${JSON.stringify(manifestData, null, 2)}\n`, "utf8");
}

main();
