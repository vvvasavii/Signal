
import { Queue } from "bullmq";
import { redisConnection } from "../lib/redis.js";

export const escalationQueue = new Queue(
  "signal-escalations",
  {
    connection: redisConnection,
  },
);
