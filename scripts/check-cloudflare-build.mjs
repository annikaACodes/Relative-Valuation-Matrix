import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "cloudflare-dist");
const required = [
  "_headers",
  "_routes.json",
  "_worker.js",
  "index.html",
  "robots.txt",
  "dashboard/app.js",
  "dashboard/styles.css",
  "dashboard/vendor/exceljs.min.js",
  "data/semiconductor_universe.csv",
  "data/calendarized_metrics.csv",
  "docs/methodology.md",
  "login/index.html",
  "login/login.css",
  "login/login.js"
];

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else files.push(path);
  }
  return files;
}

for (const path of required) {
  if (!(await stat(resolve(output, path))).isFile()) throw new Error(`Missing build file: ${path}`);
}

const routes = JSON.parse(await readFile(resolve(output, "_routes.json"), "utf8"));
if (routes.version !== 1 || routes.include?.length !== 1 || routes.include[0] !== "/*" || routes.exclude?.length) {
  throw new Error("_routes.json must route every path through the authentication Worker.");
}

const disallowed = /(^|\/)(?:\.git|\.github|database|scripts|tests)(?:\/|$)|\.(?:db|sqlite|py|map)$/iu;
const files = await filesBelow(output);
for (const file of files) {
  const path = relative(output, file).replaceAll("\\", "/");
  if (disallowed.test(path)) throw new Error(`Disallowed deploy artifact: ${path}`);
}

for (const file of files.filter((path) => !path.endsWith("exceljs.min.js"))) {
  const contents = await readFile(file, "utf8");
  if (/AUTH_(?:ACCESS_CODE_HASH|SESSION_SECRET)\s*[:=]\s*["'][A-Za-z0-9_-]{40,}/u.test(contents)) {
    throw new Error(`A deployed file appears to contain an authentication secret: ${relative(output, file)}`);
  }
}

console.log(`Verified ${files.length} Cloudflare deployment files; no excluded source or stored secret found.`);
