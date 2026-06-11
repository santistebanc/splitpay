import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const webBundleDir = new URL("../dist/_expo/static/js/web/", import.meta.url);

for (const file of await readdir(webBundleDir)) {
  if (!file.endsWith(".js")) continue;

  const path = join(webBundleDir.pathname, file);
  const source = await readFile(path, "utf8");
  const fixed = source.replaceAll("import.meta.url", "globalThis.location.href");

  if (fixed !== source) {
    await writeFile(path, fixed);
  }
}
