/**
 * One-time entity secret registration for Circle developer-controlled wallets.
 * Run once per Circle entity. NON-IDEMPOTENT.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerEntitySecretCiphertext, initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// 1. Load API key from .env file (Eligentt project) or process.env
const envPath = path.join(projectRoot, ".env");
const appEnvPath = "/home/user/app/.env";

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(
    fs.readFileSync(p, "utf8")
      .split("\n")
      .filter(l => l.includes("=") && !l.startsWith("#"))
      .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}

const env1 = loadEnvFile(envPath);
const env2 = loadEnvFile(appEnvPath);
const apiKey = process.env.CIRCLE_API_KEY || env1.CIRCLE_API_KEY || env2.CIRCLE_API_KEY;

if (!apiKey) {
  console.error("ERROR: CIRCLE_API_KEY not found in environment or .env files");
  process.exit(1);
}
console.log("API key found (length=" + apiKey.length + ")");

// 2. Generate entity secret
const entitySecret = crypto.randomBytes(32).toString("hex");
console.log("Entity secret generated (64 hex chars)");

// 3. Create recovery dir
const recoveryDir = "/home/user/app/.circle";
fs.mkdirSync(recoveryDir, { recursive: true });

// 4. Register with Circle
console.log("Registering ciphertext with Circle...");
let response;
try {
  response = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: recoveryDir,
  });
} catch (err) {
  console.error("Registration failed:", err.message || err);
  process.exit(1);
}

// 5. Save recovery file
const recoveryPath = path.join(recoveryDir, "recovery_file.dat");
if (response?.data?.recoveryFile) {
  fs.writeFileSync(recoveryPath, response.data.recoveryFile);
  console.log("Recovery file saved to: " + recoveryPath);
} else if (!fs.existsSync(recoveryPath)) {
  console.warn("Warning: recovery file not returned by API and not found on disk.");
}

// 6. Persist CIRCLE_ENTITY_SECRET to Eligentt .env
const envLine = `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`;
fs.appendFileSync(envPath, envLine, "utf-8");
// Also persist to Arc Studio .env for SDK usage here
fs.appendFileSync(appEnvPath, envLine, "utf-8");
console.log("CIRCLE_ENTITY_SECRET written to .env");

// 7. Verify registration
console.log("Verifying registration...");
try {
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  await client.listWalletSets({ pageSize: 1 });
  console.log("Verification SUCCESS — entity secret is registered and working.");
} catch (err) {
  console.error("Verification failed:", err.message || err);
  process.exit(1);
}

console.log("DONE");
