import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AscClient } from "./client.js";

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

interface UploadOperation {
  method: string;
  url: string;
  length: number;
  offset: number;
  requestHeaders: Array<{ name: string; value: string }>;
}

async function performUpload(
  operations: UploadOperation[],
  fileBuffer: Buffer,
): Promise<void> {
  for (const op of operations) {
    const chunk = fileBuffer.subarray(op.offset, op.offset + op.length);
    const body = (chunk.buffer as ArrayBuffer).slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    );
    const headers: Record<string, string> = {};
    for (const h of op.requestHeaders) headers[h.name] = h.value;
    const res = await fetch(op.url, {
      method: op.method,
      headers,
      body,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Upload chunk failed at offset ${op.offset}: ${res.status} ${body}`,
      );
    }
  }
}

async function uploadAsset(
  client: AscClient,
  opts: {
    reserveType: "appScreenshots" | "appPreviews";
    relationshipType: "appScreenshotSet" | "appPreviewSet";
    setId: string;
    filePath: string;
    extraReserveAttrs?: Record<string, unknown>;
  },
): Promise<{ id: string; attributes: Record<string, unknown> }> {
  const resolved = expandPath(opts.filePath);
  const stat = statSync(resolved);
  const fileSize = stat.size;
  const fileName = basename(resolved);
  const buffer = readFileSync(resolved);
  const md5 = createHash("md5").update(buffer).digest("hex");

  const reservePath =
    opts.reserveType === "appScreenshots" ? "/appScreenshots" : "/appPreviews";
  const relatedType =
    opts.relationshipType === "appScreenshotSet"
      ? "appScreenshotSets"
      : "appPreviewSets";

  const reserveRes = await client.post<{ data: any }>(reservePath, {
    data: {
      type: opts.reserveType,
      attributes: {
        fileName,
        fileSize,
        ...(opts.extraReserveAttrs ?? {}),
      },
      relationships: {
        [opts.relationshipType]: {
          data: { type: relatedType, id: opts.setId },
        },
      },
    },
  });

  const reservedId = reserveRes.data.id as string;
  const ops = reserveRes.data.attributes.uploadOperations as UploadOperation[];

  await performUpload(ops, buffer);

  const commitRes = await client.patch<{ data: any }>(
    `${reservePath}/${reservedId}`,
    {
      data: {
        type: opts.reserveType,
        id: reservedId,
        attributes: {
          uploaded: true,
          sourceFileChecksum: md5,
        },
      },
    },
  );
  return { id: commitRes.data.id, attributes: commitRes.data.attributes };
}

const SCREENSHOT_DISPLAY_TYPE_HINT =
  'Display type. iOS: APP_IPHONE_67, APP_IPHONE_65, APP_IPHONE_61, APP_IPHONE_58, APP_IPHONE_55, APP_IPAD_PRO_3GEN_129, APP_IPAD_PRO_129, APP_IPAD_PRO_11, APP_IPAD_105, APP_IPAD_97. macOS: APP_DESKTOP. Watch: APP_WATCH_ULTRA, APP_WATCH_SERIES_10, APP_WATCH_SERIES_7, APP_WATCH_SERIES_4, APP_WATCH_SERIES_3. tvOS: APP_APPLE_TV. visionOS: APP_APPLE_VISION_PRO.';

const PREVIEW_TYPE_HINT =
  "Preview type. iOS: IPHONE_67, IPHONE_65, IPHONE_61, IPHONE_58, IPHONE_55, IPAD_PRO_3GEN_129, IPAD_PRO_129, IPAD_PRO_11, IPAD_105, IPAD_97. macOS: DESKTOP. tvOS: APPLE_TV. visionOS: APPLE_VISION_PRO.";

export function registerMediaTools(server: McpServer, client: AscClient) {
  server.registerTool(
    "appstore_list_screenshot_sets",
    {
      description:
        "List screenshot sets (one per device display type) for a version localization.",
      inputSchema: { localizationId: z.string() },
    },
    async ({ localizationId }) => {
      const data = await client.get<{ data: any[] }>(
        `/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
        { limit: 50 },
      );
      return text(
        data.data.map((s) => ({
          id: s.id,
          displayType: s.attributes.screenshotDisplayType,
        })),
      );
    },
  );

  server.registerTool(
    "appstore_create_screenshot_set",
    {
      description:
        "Create a screenshot set for a device display type on a version localization.",
      inputSchema: {
        localizationId: z.string(),
        displayType: z.string().describe(SCREENSHOT_DISPLAY_TYPE_HINT),
      },
    },
    async ({ localizationId, displayType }) => {
      const data = await client.post<{ data: any }>("/appScreenshotSets", {
        data: {
          type: "appScreenshotSets",
          attributes: { screenshotDisplayType: displayType },
          relationships: {
            appStoreVersionLocalization: {
              data: {
                type: "appStoreVersionLocalizations",
                id: localizationId,
              },
            },
          },
        },
      });
      return text({
        id: data.data.id,
        displayType: data.data.attributes.screenshotDisplayType,
      });
    },
  );

  server.registerTool(
    "appstore_list_screenshots",
    {
      description: "List screenshots in a set (in display order).",
      inputSchema: { setId: z.string() },
    },
    async ({ setId }) => {
      const data = await client.get<{ data: any[] }>(
        `/appScreenshotSets/${setId}/appScreenshots`,
        { limit: 50 },
      );
      return text(
        data.data.map((s) => ({
          id: s.id,
          fileName: s.attributes.fileName,
          fileSize: s.attributes.fileSize,
          state: s.attributes.assetDeliveryState?.state,
          imageUrl: s.attributes.imageAsset?.templateUrl,
        })),
      );
    },
  );

  server.registerTool(
    "appstore_upload_screenshot",
    {
      description:
        "Upload a screenshot (PNG or JPEG) to a set. Handles Apple's reserve → chunked upload → commit flow with MD5 checksum.",
      inputSchema: {
        setId: z.string(),
        filePath: z
          .string()
          .describe("Path to the image. Supports ~/ expansion."),
      },
    },
    async ({ setId, filePath }) => {
      const result = await uploadAsset(client, {
        reserveType: "appScreenshots",
        relationshipType: "appScreenshotSet",
        setId,
        filePath,
      });
      return text({
        id: result.id,
        fileName: result.attributes.fileName,
        state: (result.attributes.assetDeliveryState as any)?.state,
      });
    },
  );

  server.registerTool(
    "appstore_delete_screenshot",
    {
      description: "Delete a screenshot by ID.",
      inputSchema: { screenshotId: z.string() },
    },
    async ({ screenshotId }) => {
      await client.delete(`/appScreenshots/${screenshotId}`);
      return text({ deleted: screenshotId });
    },
  );

  server.registerTool(
    "appstore_reorder_screenshots",
    {
      description:
        "Set the display order of screenshots in a set. Pass the screenshot IDs in the order you want them shown.",
      inputSchema: {
        setId: z.string(),
        screenshotIds: z.array(z.string()).min(1),
      },
    },
    async ({ setId, screenshotIds }) => {
      await client.patch(
        `/appScreenshotSets/${setId}/relationships/appScreenshots`,
        {
          data: screenshotIds.map((id) => ({ type: "appScreenshots", id })),
        },
      );
      return text({ setId, order: screenshotIds });
    },
  );

  server.registerTool(
    "appstore_list_app_preview_sets",
    {
      description: "List app preview (video) sets for a version localization.",
      inputSchema: { localizationId: z.string() },
    },
    async ({ localizationId }) => {
      const data = await client.get<{ data: any[] }>(
        `/appStoreVersionLocalizations/${localizationId}/appPreviewSets`,
        { limit: 50 },
      );
      return text(
        data.data.map((s) => ({
          id: s.id,
          previewType: s.attributes.previewType,
        })),
      );
    },
  );

  server.registerTool(
    "appstore_create_app_preview_set",
    {
      description:
        "Create an app preview (video) set for a device on a version localization.",
      inputSchema: {
        localizationId: z.string(),
        previewType: z.string().describe(PREVIEW_TYPE_HINT),
      },
    },
    async ({ localizationId, previewType }) => {
      const data = await client.post<{ data: any }>("/appPreviewSets", {
        data: {
          type: "appPreviewSets",
          attributes: { previewType },
          relationships: {
            appStoreVersionLocalization: {
              data: {
                type: "appStoreVersionLocalizations",
                id: localizationId,
              },
            },
          },
        },
      });
      return text({
        id: data.data.id,
        previewType: data.data.attributes.previewType,
      });
    },
  );

  server.registerTool(
    "appstore_list_app_previews",
    {
      description: "List app previews (videos) in a preview set.",
      inputSchema: { setId: z.string() },
    },
    async ({ setId }) => {
      const data = await client.get<{ data: any[] }>(
        `/appPreviewSets/${setId}/appPreviews`,
        { limit: 50 },
      );
      return text(
        data.data.map((p) => ({
          id: p.id,
          fileName: p.attributes.fileName,
          fileSize: p.attributes.fileSize,
          state: p.attributes.assetDeliveryState?.state,
          previewFrameTimeCode: p.attributes.previewFrameTimeCode,
        })),
      );
    },
  );

  server.registerTool(
    "appstore_upload_app_preview",
    {
      description:
        "Upload an app preview video (.mp4 / .m4v / .mov, 500 MB and 30 s max) to a preview set. Handles reserve/upload/commit.",
      inputSchema: {
        setId: z.string(),
        filePath: z.string(),
        previewFrameTimeCode: z
          .string()
          .optional()
          .describe("Poster frame time code, HH:MM:SS:FF"),
      },
    },
    async ({ setId, filePath, previewFrameTimeCode }) => {
      const result = await uploadAsset(client, {
        reserveType: "appPreviews",
        relationshipType: "appPreviewSet",
        setId,
        filePath,
        extraReserveAttrs: previewFrameTimeCode
          ? { previewFrameTimeCode }
          : undefined,
      });
      return text({
        id: result.id,
        fileName: result.attributes.fileName,
        state: (result.attributes.assetDeliveryState as any)?.state,
      });
    },
  );

  server.registerTool(
    "appstore_delete_app_preview",
    {
      description: "Delete an app preview by ID.",
      inputSchema: { previewId: z.string() },
    },
    async ({ previewId }) => {
      await client.delete(`/appPreviews/${previewId}`);
      return text({ deleted: previewId });
    },
  );
}
