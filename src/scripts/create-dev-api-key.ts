
import { prisma } from "../lib/prisma.js";
import { generateApiKey, hashApiKey } from "../lib/api-key.js";

async function main() {
  const service = await prisma.service.upsert({
    where: { name: "payment-api" },
    update: {},
    create: { name: "payment-api" },
  });

  const rawKey = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Local development key",
      keyHash: hashApiKey(rawKey),
      serviceId: service.id,
    },
  });

  console.log("Service:", service.name);
  console.log("API key (copy it now; it won't be stored in plaintext):");
  console.log(rawKey);
}

main()
  .catch((error) => {
    console.error("Failed to create development API key:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
