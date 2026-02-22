const fs = require("fs");
const path = require("path");

const PLACEHOLDER = "__APIDASH_DEFAULT_ENDPOINT__";
const file = path.resolve(__dirname, "../dist/client.js");
const endpoint = process.env.APIDASH_DEFAULT_ENDPOINT;

if (!endpoint) {
  console.log("[inject-endpoint] APIDASH_DEFAULT_ENDPOINT not set, skipping injection");
  process.exit(0);
}

const src = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, src.replace(PLACEHOLDER, endpoint));
console.log(`[inject-endpoint] Baked default endpoint: ${endpoint}`);
