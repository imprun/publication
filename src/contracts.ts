import { z } from "zod";
import { DEFAULT_CONNECTION_ID, SUPPORTED_IMAGE_TYPES } from "./config.js";

export const providerSchema = z.literal("tistory");
export type ProviderId = z.infer<typeof providerSchema>;

const connectionFields = {
  provider: providerSchema.default("tistory"),
  connectionId: z.literal(DEFAULT_CONNECTION_ID).default(DEFAULT_CONNECTION_ID),
};

export const connectionLoginInputSchema = z.object({
  ...connectionFields,
  blogHost: z.string().trim().min(1),
  accountId: z.string().trim().min(1).optional(),
});

export const connectionInputSchema = z.object(connectionFields);

export const draftFieldsSchema = z.object({
  ...connectionFields,
  title: z.string().trim().min(1).max(250),
  markdown: z.string().min(1).max(2_000_000),
  tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  categoryId: z.number().int().nonnegative().default(0),
});

export const uploadedMediaSchema = z.object({
  provider: providerSchema,
  connectionId: z.literal(DEFAULT_CONNECTION_ID),
  filename: z.string().min(1),
  mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
  size: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  attachmentRef: z.string().startsWith("kage@"),
  substitution: z.string().startsWith("[##_Image|"),
});

export const mediaUploadInputSchema = z.object({
  ...connectionFields,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
  contentBase64: z.string().min(1),
});

export const postPrepareInputSchema = draftFieldsSchema;

export const postPublishInputSchema = draftFieldsSchema.extend({
  draftHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  visibility: z.enum(["private", "public"]),
  representativeImage: uploadedMediaSchema.optional(),
});

export const postUpdateInputSchema = postPublishInputSchema.extend({
  postId: z.string().regex(/^\d+$/),
});

export const postDeleteInputSchema = z.object({
  ...connectionFields,
  postId: z.string().regex(/^\d+$/),
  expectedTitle: z.string().trim().min(1).max(250),
});

export type ConnectionLoginInput = z.infer<typeof connectionLoginInputSchema>;
export type ConnectionInput = z.infer<typeof connectionInputSchema>;
export type DraftFields = z.infer<typeof draftFieldsSchema>;
export type MediaUploadInput = z.infer<typeof mediaUploadInputSchema>;
export type UploadedMedia = z.infer<typeof uploadedMediaSchema>;
export type PostPublishInput = z.infer<typeof postPublishInputSchema>;
export type PostUpdateInput = z.infer<typeof postUpdateInputSchema>;
export type PostDeleteInput = z.infer<typeof postDeleteInputSchema>;
