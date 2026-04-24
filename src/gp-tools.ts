import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GpClient } from "./gp-client.js";

function expandPath(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function text(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

const IMAGE_TYPES = [
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "tvScreenshots",
  "wearScreenshots",
  "icon",
  "featureGraphic",
  "tvBanner",
] as const;

const TRACKS = ["production", "beta", "alpha", "internal"] as const;

const LISTING_FIELDS = {
  title: z
    .string()
    .max(30)
    .optional()
    .describe("App title, max 30 chars"),
  shortDescription: z
    .string()
    .max(80)
    .optional()
    .describe("Short description, max 80 chars (shown on listing card)"),
  fullDescription: z
    .string()
    .max(4000)
    .optional()
    .describe("Full description, max 4000 chars"),
  video: z
    .string()
    .url()
    .optional()
    .describe("YouTube video URL for the store listing"),
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export function registerGpTools(server: McpServer, client: GpClient) {
  server.registerTool(
    "playstore_get_app",
    {
      description:
        "Get basic app details from Google Play (country availability, contact info, etc.).",
      inputSchema: {
        packageName: z.string().describe("e.g. com.example.myapp"),
      },
    },
    async ({ packageName }) => {
      const data = await client.get(`/applications/${packageName}`);
      return text(data);
    },
  );

  server.registerTool(
    "playstore_list_listings",
    {
      description:
        "List all localized store listings (title, short/full description, video) for an app.",
      inputSchema: { packageName: z.string() },
    },
    async ({ packageName }) => {
      const result = await client.withEdit(
        packageName,
        async (editId) => {
          return await client.get<{ listings?: any[] }>(
            `/applications/${packageName}/edits/${editId}/listings`,
          );
        },
        { commit: false },
      );
      return text(
        (result.listings ?? []).map((l) => ({
          language: l.language,
          title: l.title,
          hasShortDescription: !!l.shortDescription,
          hasFullDescription: !!l.fullDescription,
          video: l.video,
        })),
      );
    },
  );

  server.registerTool(
    "playstore_get_listing",
    {
      description:
        "Get the full localized store listing for a single language.",
      inputSchema: {
        packageName: z.string(),
        language: z.string().describe("BCP-47, e.g. en-US, fr-FR"),
      },
    },
    async ({ packageName, language }) => {
      const result = await client.withEdit(
        packageName,
        async (editId) => {
          return await client.get(
            `/applications/${packageName}/edits/${editId}/listings/${language}`,
          );
        },
        { commit: false },
      );
      return text(result);
    },
  );

  server.registerTool(
    "playstore_update_listing",
    {
      description:
        "Update a localized store listing (title, short description, full description, video). Creates an edit, patches, and commits.",
      inputSchema: {
        packageName: z.string(),
        language: z.string().describe("BCP-47, e.g. en-US, fr-FR"),
        ...LISTING_FIELDS,
      },
    },
    async ({ packageName, language, ...rest }) => {
      const attrs = pruneUndefined(rest);
      if (Object.keys(attrs).length === 0) {
        throw new Error("Provide at least one field to update.");
      }
      const result = await client.withEdit(packageName, async (editId) => {
        return await client.patch(
          `/applications/${packageName}/edits/${editId}/listings/${language}`,
          attrs,
        );
      });
      return text({ language, updated: Object.keys(attrs), result });
    },
  );

  server.registerTool(
    "playstore_list_images",
    {
      description:
        "List uploaded images for a specific language and image type (phoneScreenshots, featureGraphic, icon, etc.).",
      inputSchema: {
        packageName: z.string(),
        language: z.string(),
        imageType: z.enum(IMAGE_TYPES),
      },
    },
    async ({ packageName, language, imageType }) => {
      const result = await client.withEdit(
        packageName,
        async (editId) => {
          return await client.get<{ images?: any[] }>(
            `/applications/${packageName}/edits/${editId}/images/${language}/${imageType}`,
          );
        },
        { commit: false },
      );
      return text(result.images ?? []);
    },
  );

  server.registerTool(
    "playstore_upload_image",
    {
      description:
        "Upload an image (PNG/JPEG/WebP) to a listing. Phone screenshots: up to 8. Feature graphic: exactly 1. Creates an edit, uploads, and commits.",
      inputSchema: {
        packageName: z.string(),
        language: z.string(),
        imageType: z.enum(IMAGE_TYPES),
        filePath: z.string().describe("Path to the image. Supports ~/."),
      },
    },
    async ({ packageName, language, imageType, filePath }) => {
      const resolved = expandPath(filePath);
      statSync(resolved);
      const buffer = readFileSync(resolved);
      const ext = extname(resolved).toLowerCase();
      const contentType = CONTENT_TYPE_BY_EXT[ext];
      if (!contentType) {
        throw new Error(`Unsupported image extension: ${ext}`);
      }
      const result = await client.withEdit(packageName, async (editId) => {
        return await client.request(
          "POST",
          `/applications/${packageName}/edits/${editId}/images/${language}/${imageType}`,
          {
            rawBody: buffer,
            contentType,
            query: { uploadType: "media" },
            upload: true,
          },
        );
      });
      return text({ imageType, language, result });
    },
  );

  server.registerTool(
    "playstore_delete_image",
    {
      description: "Delete a single image from a listing by image ID.",
      inputSchema: {
        packageName: z.string(),
        language: z.string(),
        imageType: z.enum(IMAGE_TYPES),
        imageId: z.string(),
      },
    },
    async ({ packageName, language, imageType, imageId }) => {
      await client.withEdit(packageName, async (editId) => {
        await client.delete(
          `/applications/${packageName}/edits/${editId}/images/${language}/${imageType}/${imageId}`,
        );
      });
      return text({ deleted: imageId });
    },
  );

  server.registerTool(
    "playstore_delete_all_images",
    {
      description:
        "Delete all images of a given type for a language (useful before re-uploading a fresh set of screenshots).",
      inputSchema: {
        packageName: z.string(),
        language: z.string(),
        imageType: z.enum(IMAGE_TYPES),
      },
    },
    async ({ packageName, language, imageType }) => {
      const result = await client.withEdit(packageName, async (editId) => {
        return await client.delete(
          `/applications/${packageName}/edits/${editId}/images/${language}/${imageType}`,
        );
      });
      return text({ cleared: imageType, language, result });
    },
  );

  server.registerTool(
    "playstore_list_tracks",
    {
      description:
        "List release tracks (production, beta, alpha, internal) for an app with their current releases.",
      inputSchema: { packageName: z.string() },
    },
    async ({ packageName }) => {
      const result = await client.withEdit(
        packageName,
        async (editId) => {
          return await client.get<{ tracks?: any[] }>(
            `/applications/${packageName}/edits/${editId}/tracks`,
          );
        },
        { commit: false },
      );
      return text(
        (result.tracks ?? []).map((t) => ({
          track: t.track,
          releases: (t.releases ?? []).map((r: any) => ({
            name: r.name,
            versionCodes: r.versionCodes,
            status: r.status,
            userFraction: r.userFraction,
            releaseNotesLocales: (r.releaseNotes ?? []).map(
              (rn: any) => rn.language,
            ),
          })),
        })),
      );
    },
  );

  server.registerTool(
    "playstore_get_track",
    {
      description: "Get the full track definition with releases and release notes.",
      inputSchema: {
        packageName: z.string(),
        track: z.enum(TRACKS),
      },
    },
    async ({ packageName, track }) => {
      const result = await client.withEdit(
        packageName,
        async (editId) => {
          return await client.get(
            `/applications/${packageName}/edits/${editId}/tracks/${track}`,
          );
        },
        { commit: false },
      );
      return text(result);
    },
  );

  server.registerTool(
    "playstore_update_release_notes",
    {
      description:
        "Update release notes for the latest release on a track, for one or more languages. Does not change the release status or rollout fraction.",
      inputSchema: {
        packageName: z.string(),
        track: z.enum(TRACKS),
        notes: z
          .array(
            z.object({
              language: z.string(),
              text: z.string().max(500),
            }),
          )
          .min(1)
          .describe("Array of {language, text}. 500 chars max per locale."),
      },
    },
    async ({ packageName, track, notes }) => {
      const result = await client.withEdit(packageName, async (editId) => {
        const current = await client.get<{ releases?: any[] }>(
          `/applications/${packageName}/edits/${editId}/tracks/${track}`,
        );
        const releases = current.releases ?? [];
        if (releases.length === 0) {
          throw new Error(`No releases on track ${track}.`);
        }
        const target = releases[0];
        target.releaseNotes = notes.map((n) => ({
          language: n.language,
          text: n.text,
        }));
        return await client.put(
          `/applications/${packageName}/edits/${editId}/tracks/${track}`,
          { track, releases },
        );
      });
      return text({ track, updated: notes.map((n) => n.language), result });
    },
  );

  server.registerTool(
    "playstore_set_rollout",
    {
      description:
        "Set the staged rollout percentage of the latest release on a track (0.0 to 1.0). Also supports halting or completing a rollout via status.",
      inputSchema: {
        packageName: z.string(),
        track: z.enum(TRACKS),
        userFraction: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Fraction 0-1 (ignored if status is completed/halted)"),
        status: z
          .enum(["draft", "inProgress", "halted", "completed"])
          .optional(),
      },
    },
    async ({ packageName, track, userFraction, status }) => {
      const result = await client.withEdit(packageName, async (editId) => {
        const current = await client.get<{ releases?: any[] }>(
          `/applications/${packageName}/edits/${editId}/tracks/${track}`,
        );
        const releases = current.releases ?? [];
        if (releases.length === 0) {
          throw new Error(`No releases on track ${track}.`);
        }
        const target = releases[0];
        if (status) target.status = status;
        if (userFraction !== undefined) target.userFraction = userFraction;
        return await client.put(
          `/applications/${packageName}/edits/${editId}/tracks/${track}`,
          { track, releases },
        );
      });
      return text({ track, userFraction, status, result });
    },
  );
}
