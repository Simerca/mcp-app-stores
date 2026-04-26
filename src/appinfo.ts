import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AscClient } from "./client.js";

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

const APP_INFO_EDITABLE_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
];

async function findEditableAppInfoId(
  client: AscClient,
  appId: string,
): Promise<string> {
  const infos = await client.get<{ data: any[] }>(
    `/apps/${appId}/appInfos`,
  );
  const editable =
    infos.data.find((i) =>
      APP_INFO_EDITABLE_STATES.includes(i.attributes.appStoreState),
    ) ?? infos.data[0];
  if (!editable) throw new Error(`No AppInfo found for app ${appId}`);
  return editable.id;
}

const FREQUENCY = ["NONE", "INFREQUENT_OR_MILD", "FREQUENT_OR_INTENSE"] as const;

// Age rating fields. Apple changes this schema regularly — frequency-style
// fields are kept strict; the rest are loose strings so newly-added enums
// don't require an MCP update.
const ageRatingFields = {
  // Frequency: NONE | INFREQUENT_OR_MILD | FREQUENT_OR_INTENSE
  alcoholTobaccoOrDrugUseOrReferences: z.enum(FREQUENCY).optional(),
  contests: z.enum(FREQUENCY).optional(),
  gamblingSimulated: z.enum(FREQUENCY).optional(),
  medicalOrTreatmentInformation: z.enum(FREQUENCY).optional(),
  profanityOrCrudeHumor: z.enum(FREQUENCY).optional(),
  sexualContentGraphicAndNudity: z.enum(FREQUENCY).optional(),
  sexualContentOrNudity: z.enum(FREQUENCY).optional(),
  horrorOrFearThemes: z.enum(FREQUENCY).optional(),
  matureOrSuggestiveThemes: z.enum(FREQUENCY).optional(),
  violenceCartoonOrFantasy: z.enum(FREQUENCY).optional(),
  violenceRealistic: z.enum(FREQUENCY).optional(),
  violenceRealisticProlongedGraphicOrSadistic: z.enum(FREQUENCY).optional(),
  // Newer fields (Apple 2024+ schema) — typed loosely so we don't need to
  // re-ship the MCP every time Apple flips a field between string/boolean.
  // Currently observed: some are booleans (advertising, messagingAndChat,
  // ageAssurance, healthOrWellnessTopics), others are frequency strings
  // (gunsOrOtherWeapons). Pass whichever Apple's API expects today.
  advertising: z
    .union([z.string(), z.boolean()])
    .optional()
    .describe(
      "Either a frequency (NONE | INFREQUENT_OR_MILD | FREQUENT_OR_INTENSE) or a boolean — Apple's API has shifted between the two.",
    ),
  gunsOrOtherWeapons: z
    .union([z.string(), z.boolean()])
    .optional()
    .describe("Frequency string or boolean."),
  healthOrWellnessTopics: z
    .union([z.string(), z.boolean()])
    .optional()
    .describe("Frequency string or boolean."),
  ageAssurance: z
    .union([z.string(), z.boolean()])
    .optional()
    .describe(
      "Either an age assurance method (NOT_APPLICABLE, BIOMETRIC, GOVERNMENT_ID, ...) or a boolean. Apple's API alternates.",
    ),
  lootBox: z
    .boolean()
    .optional()
    .describe("True if the app contains loot boxes."),
  messagingAndChat: z
    .union([z.string(), z.boolean()])
    .optional()
    .describe(
      "Common string values: NONE, MODERATED, UNMODERATED — but Apple may also expect a boolean today.",
    ),
  parentalControls: z
    .boolean()
    .optional()
    .describe("True if parental controls are available in the app."),
  userGeneratedContent: z
    .boolean()
    .optional()
    .describe("True if the app exposes user-generated content."),
  // Other booleans
  gambling: z.boolean().optional(),
  unrestrictedWebAccess: z.boolean().optional(),
  // Kids age band — null clears it
  kidsAgeBand: z
    .enum(["FIVE_AND_UNDER", "SIX_TO_EIGHT", "NINE_TO_ELEVEN"])
    .nullable()
    .optional(),
};

export function registerAppInfoTools(server: McpServer, client: AscClient) {
  server.registerTool(
    "appstore_get_app_info",
    {
      description:
        "Get the editable AppInfo for an app (state, age rating, primary/secondary categories). Use this to discover the appInfoId before updating categories. Note: Content Rights Declaration lives on the App resource — read it via appstore_get_app.",
      inputSchema: { appId: z.string() },
    },
    async ({ appId }) => {
      const infos = await client.get<{ data: any[] }>(
        `/apps/${appId}/appInfos`,
        {
          include:
            "primaryCategory,primaryFirstSubCategory,primaryReturnsSubCategory,secondaryCategory,secondaryFirstSubCategory,secondarySubcategoryTwo",
        },
      );
      const editable =
        infos.data.find((i) =>
          APP_INFO_EDITABLE_STATES.includes(i.attributes.appStoreState),
        ) ?? infos.data[0];
      if (!editable) return text({ found: false });
      const rels = editable.relationships ?? {};
      const relId = (k: string) => rels[k]?.data?.id ?? null;
      return text({
        id: editable.id,
        state: editable.attributes.appStoreState,
        appStoreAgeRating: editable.attributes.appStoreAgeRating,
        brazilAgeRating: editable.attributes.brazilAgeRating,
        kidsAgeBand: editable.attributes.kidsAgeBand,
        primaryCategoryId: relId("primaryCategory"),
        primaryFirstSubCategoryId: relId("primaryFirstSubCategory"),
        primarySecondSubCategoryId: relId("primaryReturnsSubCategory"),
        secondaryCategoryId: relId("secondaryCategory"),
        secondaryFirstSubCategoryId: relId("secondaryFirstSubCategory"),
        secondarySecondSubCategoryId: relId("secondarySubcategoryTwo"),
      });
    },
  );

  server.registerTool(
    "appstore_update_app",
    {
      description:
        "Update attributes on the App resource. Most useful for `contentRightsDeclaration` (Content Rights Declaration), which lives on /apps/{id}, NOT on /appInfos/{id}. Accepted values: USES_THIRD_PARTY_CONTENT | DOES_NOT_USE_THIRD_PARTY_CONTENT.",
      inputSchema: {
        appId: z.string(),
        contentRightsDeclaration: z
          .enum(["USES_THIRD_PARTY_CONTENT", "DOES_NOT_USE_THIRD_PARTY_CONTENT"])
          .optional(),
        primaryLocale: z.string().optional(),
      },
    },
    async ({ appId, ...rest }) => {
      const attrs = pruneUndefined(rest);
      if (Object.keys(attrs).length === 0) {
        throw new Error("Provide at least one field to update.");
      }
      const data = await client.patch<{ data: any }>(`/apps/${appId}`, {
        data: { type: "apps", id: appId, attributes: attrs },
      });
      return text({ id: data.data.id, updated: Object.keys(attrs) });
    },
  );

  server.registerTool(
    "appstore_list_app_categories",
    {
      description:
        "List all available App Store categories and their subcategories. Use the IDs returned here when calling appstore_set_app_categories.",
      inputSchema: {
        platform: z
          .enum(["IOS", "MAC_OS", "TV_OS"])
          .optional()
          .describe("Filter to a platform's categories"),
      },
    },
    async ({ platform }) => {
      const query: Record<string, string | number> = { limit: 200 };
      if (platform) query["filter[platforms]"] = platform;
      const data = await client.get<{ data: any[]; included?: any[] }>(
        "/appCategories",
        { ...query, include: "subcategories" },
      );
      const subById = new Map<string, any>();
      for (const sub of data.included ?? []) subById.set(sub.id, sub);
      return text(
        data.data.map((c) => ({
          id: c.id,
          platforms: c.attributes.platforms,
          subcategoryIds: (c.relationships?.subcategories?.data ?? []).map(
            (s: any) => s.id,
          ),
        })),
      );
    },
  );

  server.registerTool(
    "appstore_set_app_categories",
    {
      description:
        "Set primary and/or secondary categories (and subcategories) on the editable AppInfo via a single PATCH. Pass null to clear a relationship, omit to leave it unchanged. Look up category IDs via appstore_list_app_categories.",
      inputSchema: {
        appId: z.string().optional(),
        appInfoId: z.string().optional(),
        primaryCategoryId: z.string().nullable().optional(),
        primaryFirstSubCategoryId: z.string().nullable().optional(),
        primarySecondSubCategoryId: z.string().nullable().optional(),
        secondaryCategoryId: z.string().nullable().optional(),
        secondaryFirstSubCategoryId: z.string().nullable().optional(),
        secondarySecondSubCategoryId: z.string().nullable().optional(),
      },
    },
    async ({ appId, appInfoId, ...rels }) => {
      const id =
        appInfoId ??
        (appId ? await findEditableAppInfoId(client, appId) : undefined);
      if (!id) throw new Error("Provide either appId or appInfoId.");

      const relMap: Array<{ key: string; rel: string }> = [
        { key: "primaryCategoryId", rel: "primaryCategory" },
        { key: "primaryFirstSubCategoryId", rel: "primaryFirstSubCategory" },
        {
          key: "primarySecondSubCategoryId",
          rel: "primaryReturnsSubCategory",
        },
        { key: "secondaryCategoryId", rel: "secondaryCategory" },
        {
          key: "secondaryFirstSubCategoryId",
          rel: "secondaryFirstSubCategory",
        },
        {
          key: "secondarySecondSubCategoryId",
          rel: "secondarySubcategoryTwo",
        },
      ];

      const relationships: Record<string, { data: { type: string; id: string } | null }> = {};
      const updated: string[] = [];
      for (const { key, rel } of relMap) {
        const value = (rels as Record<string, string | null | undefined>)[key];
        if (value === undefined) continue;
        relationships[rel] = {
          data: value === null ? null : { type: "appCategories", id: value },
        };
        updated.push(rel);
      }
      if (updated.length === 0) {
        throw new Error("Provide at least one category field to update.");
      }

      const data = await client.patch<{ data: any }>(`/appInfos/${id}`, {
        data: {
          type: "appInfos",
          id,
          relationships,
        },
      });
      return text({ id: data.data.id, updated });
    },
  );

  server.registerTool(
    "appstore_get_age_rating",
    {
      description:
        "Get the age rating questionnaire (declarations) for an app. Returns the ID needed by appstore_update_age_rating along with current answers.",
      inputSchema: {
        appId: z.string().optional(),
        appInfoId: z.string().optional(),
      },
    },
    async ({ appId, appInfoId }) => {
      const id =
        appInfoId ??
        (appId ? await findEditableAppInfoId(client, appId) : undefined);
      if (!id) throw new Error("Provide either appId or appInfoId.");
      const data = await client.get<{ data: any }>(
        `/appInfos/${id}/ageRatingDeclaration`,
      );
      if (!data?.data) return text({ found: false });
      return text({
        id: data.data.id,
        ...data.data.attributes,
      });
    },
  );

  server.registerTool(
    "appstore_update_age_rating",
    {
      description:
        "Update the age rating questionnaire. Frequency fields use NONE | INFREQUENT_OR_MILD | FREQUENT_OR_INTENSE. Booleans: gambling, unrestrictedWebAccess, lootBox, parentalControls, userGeneratedContent. kidsAgeBand: FIVE_AND_UNDER | SIX_TO_EIGHT | NINE_TO_ELEVEN | null. For a casual no-content app, set every frequency to NONE and every boolean to false. The API may require all fields on submit — use appstore_get_age_rating first to see what's already set.",
      inputSchema: {
        ageRatingDeclarationId: z.string(),
        ...ageRatingFields,
      },
    },
    async ({ ageRatingDeclarationId, ...rest }) => {
      const attrs = pruneUndefined(rest);
      if (Object.keys(attrs).length === 0) {
        throw new Error("Provide at least one field to update.");
      }
      const data = await client.patch<{ data: any }>(
        `/ageRatingDeclarations/${ageRatingDeclarationId}`,
        {
          data: {
            type: "ageRatingDeclarations",
            id: ageRatingDeclarationId,
            attributes: attrs,
          },
        },
      );
      return text({ id: data.data.id, updated: Object.keys(attrs) });
    },
  );
}
