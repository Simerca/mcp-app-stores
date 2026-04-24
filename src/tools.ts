import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AscClient } from "./client.js";

const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;

const EDITABLE_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
].join(",");

const versionLocalizationFields = {
  description: z
    .string()
    .max(4000)
    .optional()
    .describe("App description, max 4000 chars"),
  keywords: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Comma-separated keywords, 100 chars total max, no spaces after commas (e.g. 'todo,planner,productivity')",
    ),
  promotionalText: z
    .string()
    .max(170)
    .optional()
    .describe(
      "Promotional text, max 170 chars. Unlike other fields, this can be updated on a live version.",
    ),
  whatsNew: z
    .string()
    .max(4000)
    .optional()
    .describe("'What's new in this version', max 4000 chars"),
  marketingUrl: z.string().url().optional(),
  supportUrl: z.string().url().optional(),
};

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

export function registerTools(server: McpServer, client: AscClient) {
  server.registerTool(
    "appstore_list_apps",
    {
      description: "List all apps in your App Store Connect team.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ limit }) => {
      const data = await client.get<{ data: any[] }>("/apps", {
        limit: limit ?? 200,
        "fields[apps]": "name,bundleId,sku,primaryLocale",
      });
      return text(
        data.data.map((a) => ({
          id: a.id,
          name: a.attributes.name,
          bundleId: a.attributes.bundleId,
          sku: a.attributes.sku,
          primaryLocale: a.attributes.primaryLocale,
        })),
      );
    },
  );

  server.registerTool(
    "appstore_get_app",
    {
      description: "Get full details for a single app by its ID.",
      inputSchema: { appId: z.string().describe("App Store Connect app ID") },
    },
    async ({ appId }) => {
      const data = await client.get<{ data: any }>(`/apps/${appId}`);
      return text({ id: data.data.id, ...data.data.attributes });
    },
  );

  server.registerTool(
    "appstore_list_app_versions",
    {
      description:
        "List App Store versions for an app. Editable states (PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, METADATA_REJECTED, ...) are where metadata can be changed.",
      inputSchema: {
        appId: z.string(),
        platform: z.enum(PLATFORMS).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ appId, platform, limit }) => {
      const query: Record<string, string | number> = {
        limit: limit ?? 50,
        "fields[appStoreVersions]":
          "versionString,platform,appStoreState,createdDate,releaseType",
      };
      if (platform) query["filter[platform]"] = platform;
      const data = await client.get<{ data: any[] }>(
        `/apps/${appId}/appStoreVersions`,
        query,
      );
      return text(
        data.data.map((v) => ({
          id: v.id,
          versionString: v.attributes.versionString,
          platform: v.attributes.platform,
          state: v.attributes.appStoreState,
          createdDate: v.attributes.createdDate,
          releaseType: v.attributes.releaseType,
        })),
      );
    },
  );

  server.registerTool(
    "appstore_find_editable_version",
    {
      description:
        "Find the most recent editable App Store version for an app (where metadata can still be changed). Call this before editing localizations.",
      inputSchema: {
        appId: z.string(),
        platform: z
          .enum(PLATFORMS)
          .optional()
          .describe("Defaults to IOS"),
      },
    },
    async ({ appId, platform }) => {
      const data = await client.get<{ data: any[] }>(
        `/apps/${appId}/appStoreVersions`,
        {
          "filter[platform]": platform ?? "IOS",
          "filter[appStoreState]": EDITABLE_STATES,
          limit: 5,
        },
      );
      if (data.data.length === 0) {
        return text({
          found: false,
          message:
            "No editable version found. Create one with create_app_version.",
        });
      }
      const v = data.data[0];
      return text({
        found: true,
        id: v.id,
        versionString: v.attributes.versionString,
        state: v.attributes.appStoreState,
        platform: v.attributes.platform,
      });
    },
  );

  server.registerTool(
    "appstore_create_app_version",
    {
      description:
        "Create a new App Store version. Starts in PREPARE_FOR_SUBMISSION so its metadata (localizations) can be edited.",
      inputSchema: {
        appId: z.string(),
        versionString: z
          .string()
          .regex(/^\d+(\.\d+){1,2}$/)
          .describe("Semantic version, e.g. 1.2.3"),
        platform: z.enum(PLATFORMS).optional().describe("Defaults to IOS"),
      },
    },
    async ({ appId, versionString, platform }) => {
      const data = await client.post<{ data: any }>("/appStoreVersions", {
        data: {
          type: "appStoreVersions",
          attributes: { platform: platform ?? "IOS", versionString },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      });
      return text({
        id: data.data.id,
        versionString: data.data.attributes.versionString,
        state: data.data.attributes.appStoreState,
      });
    },
  );

  server.registerTool(
    "appstore_list_version_localizations",
    {
      description:
        "List all per-locale metadata entries (description, keywords, etc.) for an App Store version.",
      inputSchema: { versionId: z.string() },
    },
    async ({ versionId }) => {
      const data = await client.get<{ data: any[] }>(
        `/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
        { limit: 200 },
      );
      return text(
        data.data.map((l) => ({
          id: l.id,
          locale: l.attributes.locale,
          hasDescription: !!l.attributes.description,
          hasKeywords: !!l.attributes.keywords,
          hasPromotionalText: !!l.attributes.promotionalText,
          hasWhatsNew: !!l.attributes.whatsNew,
        })),
      );
    },
  );

  server.registerTool(
    "appstore_get_version_localization",
    {
      description:
        "Get full ASO metadata for a single locale: description, keywords, promotional text, what's new, marketing/support URLs.",
      inputSchema: { localizationId: z.string() },
    },
    async ({ localizationId }) => {
      const data = await client.get<{ data: any }>(
        `/appStoreVersionLocalizations/${localizationId}`,
      );
      return text({ id: data.data.id, ...data.data.attributes });
    },
  );

  server.registerTool(
    "appstore_update_version_localization",
    {
      description:
        "Update ASO metadata for a single locale of an editable version. Only fields you pass are changed. Most fields require the version to be in an editable state; promotionalText is the exception and can be updated on live versions.",
      inputSchema: {
        localizationId: z.string(),
        ...versionLocalizationFields,
      },
    },
    async ({ localizationId, ...rest }) => {
      const attrs = pruneUndefined(rest);
      if (Object.keys(attrs).length === 0) {
        throw new Error("Provide at least one field to update.");
      }
      const data = await client.patch<{ data: any }>(
        `/appStoreVersionLocalizations/${localizationId}`,
        {
          data: {
            type: "appStoreVersionLocalizations",
            id: localizationId,
            attributes: attrs,
          },
        },
      );
      return text({
        id: data.data.id,
        locale: data.data.attributes.locale,
        updated: Object.keys(attrs),
      });
    },
  );

  server.registerTool(
    "appstore_create_version_localization",
    {
      description:
        "Add a new locale (e.g. fr-FR, de-DE) to an editable App Store version with ASO fields.",
      inputSchema: {
        versionId: z.string(),
        locale: z.string().describe("BCP-47 locale, e.g. fr-FR"),
        ...versionLocalizationFields,
      },
    },
    async ({ versionId, locale, ...rest }) => {
      const attrs = { locale, ...pruneUndefined(rest) };
      const data = await client.post<{ data: any }>(
        "/appStoreVersionLocalizations",
        {
          data: {
            type: "appStoreVersionLocalizations",
            attributes: attrs,
            relationships: {
              appStoreVersion: {
                data: { type: "appStoreVersions", id: versionId },
              },
            },
          },
        },
      );
      return text({ id: data.data.id, locale: data.data.attributes.locale });
    },
  );

  server.registerTool(
    "appstore_list_app_info_localizations",
    {
      description:
        "List app-level localizations (name, subtitle, privacy policy URL). These live on the editable AppInfo, not on a specific version.",
      inputSchema: { appId: z.string() },
    },
    async ({ appId }) => {
      const infos = await client.get<{ data: any[] }>(
        `/apps/${appId}/appInfos`,
      );
      const editable =
        infos.data.find((i) =>
          [
            "PREPARE_FOR_SUBMISSION",
            "DEVELOPER_REJECTED",
            "REJECTED",
            "METADATA_REJECTED",
          ].includes(i.attributes.appStoreState),
        ) ?? infos.data[0];
      if (!editable) throw new Error("No AppInfo found for app.");

      const locs = await client.get<{ data: any[] }>(
        `/appInfos/${editable.id}/appInfoLocalizations`,
        { limit: 200 },
      );
      return text({
        appInfoId: editable.id,
        state: editable.attributes.appStoreState,
        localizations: locs.data.map((l) => ({
          id: l.id,
          locale: l.attributes.locale,
          name: l.attributes.name,
          subtitle: l.attributes.subtitle,
          privacyPolicyUrl: l.attributes.privacyPolicyUrl,
        })),
      });
    },
  );

  server.registerTool(
    "appstore_update_app_info_localization",
    {
      description:
        "Update app-level metadata for a locale: name (30 char), subtitle (30 char), privacy policy URL.",
      inputSchema: {
        localizationId: z.string(),
        name: z
          .string()
          .max(30)
          .optional()
          .describe("App name, max 30 chars"),
        subtitle: z
          .string()
          .max(30)
          .optional()
          .describe("Subtitle, max 30 chars"),
        privacyPolicyUrl: z.string().url().optional(),
        privacyPolicyText: z.string().optional(),
      },
    },
    async ({ localizationId, ...rest }) => {
      const attrs = pruneUndefined(rest);
      if (Object.keys(attrs).length === 0) {
        throw new Error("Provide at least one field to update.");
      }
      const data = await client.patch<{ data: any }>(
        `/appInfoLocalizations/${localizationId}`,
        {
          data: {
            type: "appInfoLocalizations",
            id: localizationId,
            attributes: attrs,
          },
        },
      );
      return text({
        id: data.data.id,
        locale: data.data.attributes?.locale,
        updated: Object.keys(attrs),
      });
    },
  );
}
