import { createHash, randomBytes } from "node:crypto";

export function generateApiKey(): string {
  return `sig_${randomBytes(32).toString("hex")}`;
} //creates a random secretwith 256 characters and returns it as a string with the prefix "sig_"

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
} //conevrts the secret into a hash using the SHA-256 algorithm and returns it as a string