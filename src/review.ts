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

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
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
    const res = await fetch(op.url, { method: op.method, headers, body });
    if (!res.ok) {
      throw new Error(
        `Upload chunk failed at offset ${op.offset}: ${res.status} ${await res.text()}`,
      );
    }
  }
}

const reviewDetailFields = {
  contactFirstName: z.string().optional(),
  contactLastName: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().email().optional(),
  demoAccountName: z.string().optional(),
  demoAccountPassword: z.string().optional(),
  demoAccountRequired: z
    .boolean()
    .optional()
    .describe("True if your app needs a demo account for review."),
  notes: z
    .string()
    .max(4000)
    .optional()
    .describe("Notes for the App Review team, max 4000 chars."),
};

export function registerReviewTools(server: McpServer, client: AscClient) {
  server.registerTool(
    "appstore_get_review_details",
    {
      description:
        "Get the App Review Information (contact info, demo account, notes) attached to an App Store version. Returns null when none exists yet.",
      inputSchema: { versionId: z.string() },
    },
    async ({ versionId }) => {
      try {
        const data = await client.get<{ data: any }>(
          `/appStoreVersions/${versionId}/appStoreReviewDetail`,
        );
        if (!data.data) return text({ found: false });
        return text({
          found: true,
          id: data.data.id,
          ...data.data.attributes,
        });
      } catch (err: any) {
        if (String(err?.message ?? err).includes("404")) {
          return text({ found: false });
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "appstore_update_review_details",
    {
      description:
        "Create or update the App Review Information for a version: contact first/last name, phone, email, demo account credentials, sign-in required flag, notes. Pass versionId to auto-create the resource if missing, or reviewDetailId to patch an existing one.",
      inputSchema: {
        versionId: z
          .string()
          .optional()
          .describe(
            "If provided and no review detail exists yet, one is created and linked to this version.",
          ),
        reviewDetailId: z
          .string()
          .optional()
          .describe("Existing appStoreReviewDetails ID to patch."),
        ...reviewDetailFields,
      },
    },
    async ({ versionId, reviewDetailId, ...rest }) => {
      const attrs = pruneUndefined(rest);
      if (!versionId && !reviewDetailId) {
        throw new Error("Provide either versionId or reviewDetailId.");
      }

      let id = reviewDetailId;
      if (!id && versionId) {
        try {
          const existing = await client.get<{ data: any }>(
            `/appStoreVersions/${versionId}/appStoreReviewDetail`,
          );
          if (existing?.data?.id) id = existing.data.id;
        } catch (err: any) {
          if (!String(err?.message ?? err).includes("404")) throw err;
        }
      }

      if (!id) {
        if (Object.keys(attrs).length === 0) {
          throw new Error("Provide at least one field when creating.");
        }
        const created = await client.post<{ data: any }>(
          "/appStoreReviewDetails",
          {
            data: {
              type: "appStoreReviewDetails",
              attributes: attrs,
              relationships: {
                appStoreVersion: {
                  data: { type: "appStoreVersions", id: versionId },
                },
              },
            },
          },
        );
        return text({
          id: created.data.id,
          created: true,
          fields: Object.keys(attrs),
        });
      }

      if (Object.keys(attrs).length === 0) {
        throw new Error("Provide at least one field to update.");
      }
      const updated = await client.patch<{ data: any }>(
        `/appStoreReviewDetails/${id}`,
        {
          data: {
            type: "appStoreReviewDetails",
            id,
            attributes: attrs,
          },
        },
      );
      return text({
        id: updated.data.id,
        updated: Object.keys(attrs),
      });
    },
  );

  server.registerTool(
    "appstore_list_review_attachments",
    {
      description:
        "List attachments (e.g. screen recording) attached to an App Review Information resource.",
      inputSchema: { reviewDetailId: z.string() },
    },
    async ({ reviewDetailId }) => {
      const data = await client.get<{ data: any[] }>(
        `/appStoreReviewDetails/${reviewDetailId}/appStoreReviewAttachments`,
        { limit: 50 },
      );
      return text(
        data.data.map((a) => ({
          id: a.id,
          fileName: a.attributes.fileName,
          fileSize: a.attributes.fileSize,
          state: a.attributes.assetDeliveryState?.state,
        })),
      );
    },
  );

  server.registerTool(
    "appstore_upload_review_attachment",
    {
      description:
        "Upload a review attachment (e.g. screen recording video) for the App Review team. Handles reserve → chunked upload → commit. Max 5 attachments, each up to ~500 MB. Common formats: .mp4, .mov, .pdf, .png, .jpg.",
      inputSchema: {
        reviewDetailId: z.string(),
        filePath: z
          .string()
          .describe("Path to the attachment. Supports ~/ expansion."),
      },
    },
    async ({ reviewDetailId, filePath }) => {
      const resolved = expandPath(filePath);
      const stat = statSync(resolved);
      const fileSize = stat.size;
      const fileName = basename(resolved);
      const buffer = readFileSync(resolved);
      const md5 = createHash("md5").update(buffer).digest("hex");

      const reserveRes = await client.post<{ data: any }>(
        "/appStoreReviewAttachments",
        {
          data: {
            type: "appStoreReviewAttachments",
            attributes: { fileName, fileSize },
            relationships: {
              appStoreReviewDetail: {
                data: {
                  type: "appStoreReviewDetails",
                  id: reviewDetailId,
                },
              },
            },
          },
        },
      );

      const reservedId = reserveRes.data.id as string;
      const ops = reserveRes.data.attributes
        .uploadOperations as UploadOperation[];

      await performUpload(ops, buffer);

      const commitRes = await client.patch<{ data: any }>(
        `/appStoreReviewAttachments/${reservedId}`,
        {
          data: {
            type: "appStoreReviewAttachments",
            id: reservedId,
            attributes: { uploaded: true, sourceFileChecksum: md5 },
          },
        },
      );
      return text({
        id: commitRes.data.id,
        fileName: commitRes.data.attributes.fileName,
        state: commitRes.data.attributes.assetDeliveryState?.state,
      });
    },
  );

  server.registerTool(
    "appstore_delete_review_attachment",
    {
      description: "Delete a review attachment by ID.",
      inputSchema: { attachmentId: z.string() },
    },
    async ({ attachmentId }) => {
      await client.delete(`/appStoreReviewAttachments/${attachmentId}`);
      return text({ deleted: attachmentId });
    },
  );
}
