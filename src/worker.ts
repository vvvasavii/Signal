
import "dotenv/config";
import { escalationWorker } from "./workers/escalation.worker.js";
import { prisma } from "./lib/prisma.js";
import { redisConnection } from "./lib/redis.js";

// Start the worker as a separate process from the Express API.
console.info("Signal escalation worker started");

let isShuttingDown = false;

async function shutdown(signal: string) {
  // Avoid running shutdown twice if multiple signals arrive.
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.info(`Received ${signal}. Shutting down worker...`);

  try {
    // Stop accepting jobs and wait for active jobs to finish.
    await escalationWorker.close();

    // Release database and Redis connections cleanly.
    await prisma.$disconnect();
    await redisConnection.quit();

    console.info("Signal worker shut down cleanly");
    process.exit(0);
  } catch (error) {
    console.error("Worker shutdown failed:", error);
    process.exit(1);
  }
}

// Handle normal terminal shutdown and container termination.
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
