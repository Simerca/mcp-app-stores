import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AscClient } from "./client.js";

const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;

function text(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

export function registerSubmissionTools(server: McpServer, client: AscClient) {
  server.registerTool(
    "appstore_submit_version_for_review",
    {
      description:
        "Submit an App Store version for App Review. Runs the full reviewSubmissions flow: create submission → add version as an item → mark submitted. Make sure the binary is uploaded and all required metadata/screenshots are set first.",
      inputSchema: {
        appId: z.string(),
        versionId: z.string(),
        platform: z
          .enum(PLATFORMS)
          .optional()
          .describe("Defaults to IOS. Must match the version's platform."),
      },
    },
    async ({ appId, versionId, platform }) => {
      const submission = await client.post<{ data: any }>(
        "/reviewSubmissions",
        {
          data: {
            type: "reviewSubmissions",
            attributes: { platform: platform ?? "IOS" },
            relationships: { app: { data: { type: "apps", id: appId } } },
          },
        },
      );
      const submissionId = submission.data.id as string;

      await client.post("/reviewSubmissionItems", {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: {
              data: { type: "reviewSubmissions", id: submissionId },
            },
            appStoreVersion: {
              data: { type: "appStoreVersions", id: versionId },
            },
          },
        },
      });

      const finalized = await client.patch<{ data: any }>(
        `/reviewSubmissions/${submissionId}`,
        {
          data: {
            type: "reviewSubmissions",
            id: submissionId,
            attributes: { submitted: true },
          },
        },
      );

      return text({
        submissionId,
        state: finalized.data.attributes?.state,
        versionId,
      });
    },
  );

  server.registerTool(
    "appstore_list_review_submissions",
    {
      description:
        "List review submissions for an app (shows state: READY_FOR_REVIEW, IN_REVIEW, COMPLETE, etc.).",
      inputSchema: {
        appId: z.string(),
        platform: z.enum(PLATFORMS).optional(),
      },
    },
    async ({ appId, platform }) => {
      const query: Record<string, string | number> = {
        "filter[app]": appId,
        limit: 20,
      };
      if (platform) query["filter[platform]"] = platform;
      const data = await client.get<{ data: any[] }>(
        "/reviewSubmissions",
        query,
      );
      return text(
        data.data.map((s) => ({
          id: s.id,
          state: s.attributes.state,
          platform: s.attributes.platform,
          submittedDate: s.attributes.submittedDate,
        })),
      );
    },
  );
}
