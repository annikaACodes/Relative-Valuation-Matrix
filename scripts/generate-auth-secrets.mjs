import { createHash, randomBytes } from "node:crypto";

const accessCode = randomBytes(24).toString("base64url");
const accessCodeHash = createHash("sha256").update(accessCode, "utf8").digest("base64url");
const sessionSecret = randomBytes(32).toString("base64url");

console.log("Keep these values private. This script does not save them.");
console.log("");
console.log(`Access code to distribute: ${accessCode}`);
console.log(`AUTH_ACCESS_CODE_HASH: ${accessCodeHash}`);
console.log(`AUTH_SESSION_SECRET: ${sessionSecret}`);
