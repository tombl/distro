import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const docs = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    draft: z.boolean().default(false),
    section: z.enum(["tutorials", "howtos", "reference", "explanation"]),
    order: z.number(),
  }),
});

export const collections = { docs };
