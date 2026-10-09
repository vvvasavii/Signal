
import { z } from "zod";

export const alertSchema = z.object({
  service: z.string().trim().min(1),
  environment: z.string().trim().min(1),

  severity: z.enum(["INFO", "WARNING", "CRITICAL"]),

  dedupKey: z
    .string()
    .trim()
    .min(1, "dedupKey cannot be empty")
    .max(200, "dedupKey cannot exceed 200 characters"),

  action: z.enum(["trigger", "resolve"]),

  message: z.string().trim().min(1),

  timestamp: z.iso.datetime().optional(),

  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type AlertInput = z.infer<typeof alertSchema>; // this defines the type for the input data that will be validated against the schema
