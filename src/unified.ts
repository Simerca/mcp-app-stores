import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AscClient } from "./client.js";
import type { GpClient } from "./gp-client.js";
import { loadMapping, resolveProduct } from "./mapping.js";

function text(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

export function registerUnifiedTools(
  server: McpServer,
  asc: AscClient | null,
  gp: GpClient | null,
) {
  server.registerTool(
    "list_all_apps",
    {
      description:
        "List all apps across App Store Connect and Google Play. Returns a unified list tagged with `store`. App Store apps come from the ASC API; Play Store apps come from the local apps.json mapping (Play API has no list endpoint).",
      inputSchema: {},
    },
    async () => {
      const out: any[] = [];

      if (asc) {
        try {
          const data = await asc.get<{ data: any[] }>("/apps", {
            limit: 200,
            "fields[apps]": "name,bundleId,sku,primaryLocale",
          });
          for (const a of data.data) {
            out.push({
              store: "appstore",
              id: a.id,
              name: a.attributes.name,
              bundleId: a.attributes.bundleId,
              primaryLocale: a.attributes.primaryLocale,
            });
          }
        } catch (err) {
          out.push({ store: "appstore", error: String(err) });
        }
      }

      const map = loadMapping();
      for (const [key, m] of Object.entries(map)) {
        if (m.playstore) {
          out.push({
            store: "playstore",
            productKey: key,
            packageName: m.playstore.packageName,
          });
        }
      }

      return text(out);
    },
  );

  server.registerTool(
    "list_product_keys",
    {
      description:
        "List product keys defined in apps.json (used by cross-store tools to reference the same app on both stores).",
      inputSchema: {},
    },
    async () => {
      const map = loadMapping();
      return text(
        Object.entries(map).map(([key, m]) => ({
          key,
          appstore: m.appstore?.appId,
          playstore: m.playstore?.packageName,
        })),
      );
    },
  );

  server.registerTool(
    "get_aso_snapshot",
    {
      description:
        "Get ASO metadata for a product across both stores for a given locale. Returns an object with `appstore` (description/keywords/subtitle/promoText/whatsNew) and `playstore` (title/shortDescription/fullDescription) side by side.",
      inputSchema: {
        productKey: z
          .string()
          .describe("Key from apps.json, e.g. 'myapp'"),
        locale: z
          .string()
          .describe(
            "Locale. Used as-is for ASC (e.g. fr-FR) and as BCP-47 for Play (e.g. fr-FR).",
          ),
      },
    },
    async ({ productKey, locale }) => {
      const product = resolveProduct(productKey);
      const snapshot: any = { productKey, locale };

      if (product.appstore && asc) {
        try {
          const appId = product.appstore.appId;
          const versions = await asc.get<{ data: any[] }>(
            `/apps/${appId}/appStoreVersions`,
            { limit: 5 },
          );
          const v = versions.data[0];
          if (!v) {
            snapshot.appstore = { error: "No versions found" };
          } else {
            const locs = await asc.get<{ data: any[] }>(
              `/appStoreVersions/${v.id}/appStoreVersionLocalizations`,
              { limit: 200 },
            );
            const match = locs.data.find(
              (l) => l.attributes.locale === locale,
            );
            const infos = await asc.get<{ data: any[] }>(
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
            const appInfoLocs = editable
              ? await asc.get<{ data: any[] }>(
                  `/appInfos/${editable.id}/appInfoLocalizations`,
                  { limit: 200 },
                )
              : { data: [] };
            const infoMatch = appInfoLocs.data.find(
              (l) => l.attributes.locale === locale,
            );

            snapshot.appstore = {
              versionId: v.id,
              versionString: v.attributes.versionString,
              state: v.attributes.appStoreState,
              locale,
              name: infoMatch?.attributes.name,
              subtitle: infoMatch?.attributes.subtitle,
              description: match?.attributes.description,
              keywords: match?.attributes.keywords,
              promotionalText: match?.attributes.promotionalText,
              whatsNew: match?.attributes.whatsNew,
              marketingUrl: match?.attributes.marketingUrl,
              supportUrl: match?.attributes.supportUrl,
            };
          }
        } catch (err) {
          snapshot.appstore = { error: String(err) };
        }
      }

      if (product.playstore && gp) {
        try {
          const pkg = product.playstore.packageName;
          const listing = await gp.withEdit(
            pkg,
            async (editId) => {
              return await gp.get(
                `/applications/${pkg}/edits/${editId}/listings/${locale}`,
              );
            },
            { commit: false },
          );
          snapshot.playstore = listing;
        } catch (err) {
          snapshot.playstore = { error: String(err) };
        }
      }

      return text(snapshot);
    },
  );

  server.registerTool(
    "update_aso_common",
    {
      description:
        "Update ASO fields that exist on BOTH stores in one call. Mappings: `title` → ASC app name + Play title, `shortDescription` → ASC subtitle (trimmed to 30) + Play shortDescription, `longDescription` → ASC description + Play fullDescription. Only the stores present in apps.json for this productKey are updated.",
      inputSchema: {
        productKey: z.string(),
        locale: z.string().describe("e.g. fr-FR"),
        title: z.string().max(30).optional(),
        shortDescription: z
          .string()
          .max(80)
          .optional()
          .describe(
            "Up to 80 chars (Play limit). Truncated to 30 for App Store subtitle.",
          ),
        longDescription: z.string().max(4000).optional(),
      },
    },
    async ({ productKey, locale, title, shortDescription, longDescription }) => {
      const product = resolveProduct(productKey);
      const report: any = { productKey, locale, updated: {} };

      if (product.appstore && asc) {
        try {
          const appId = product.appstore.appId;
          const tasks: Promise<unknown>[] = [];

          if (title !== undefined || shortDescription !== undefined) {
            const infos = await asc.get<{ data: any[] }>(
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
            const appInfoLocs = await asc.get<{ data: any[] }>(
              `/appInfos/${editable.id}/appInfoLocalizations`,
              { limit: 200 },
            );
            const infoMatch = appInfoLocs.data.find(
              (l) => l.attributes.locale === locale,
            );
            if (infoMatch) {
              const attrs: Record<string, string> = {};
              if (title !== undefined) attrs.name = title;
              if (shortDescription !== undefined)
                attrs.subtitle = shortDescription.slice(0, 30);
              tasks.push(
                asc.patch(`/appInfoLocalizations/${infoMatch.id}`, {
                  data: {
                    type: "appInfoLocalizations",
                    id: infoMatch.id,
                    attributes: attrs,
                  },
                }),
              );
            }
          }

          if (longDescription !== undefined) {
            const versions = await asc.get<{ data: any[] }>(
              `/apps/${appId}/appStoreVersions`,
              { limit: 5 },
            );
            const v = versions.data[0];
            if (v) {
              const locs = await asc.get<{ data: any[] }>(
                `/appStoreVersions/${v.id}/appStoreVersionLocalizations`,
                { limit: 200 },
              );
              const match = locs.data.find(
                (l) => l.attributes.locale === locale,
              );
              if (match) {
                tasks.push(
                  asc.patch(
                    `/appStoreVersionLocalizations/${match.id}`,
                    {
                      data: {
                        type: "appStoreVersionLocalizations",
                        id: match.id,
                        attributes: { description: longDescription },
                      },
                    },
                  ),
                );
              }
            }
          }

          await Promise.all(tasks);
          report.updated.appstore = { ok: true, fieldsTouched: tasks.length };
        } catch (err) {
          report.updated.appstore = { error: String(err) };
        }
      }

      if (product.playstore && gp) {
        try {
          const pkg = product.playstore.packageName;
          const attrs: Record<string, string> = {};
          if (title !== undefined) attrs.title = title;
          if (shortDescription !== undefined)
            attrs.shortDescription = shortDescription;
          if (longDescription !== undefined)
            attrs.fullDescription = longDescription;

          if (Object.keys(attrs).length > 0) {
            await gp.withEdit(pkg, async (editId) => {
              await gp.patch(
                `/applications/${pkg}/edits/${editId}/listings/${locale}`,
                attrs,
              );
            });
          }
          report.updated.playstore = {
            ok: true,
            fields: Object.keys(attrs),
          };
        } catch (err) {
          report.updated.playstore = { error: String(err) };
        }
      }

      return text(report);
    },
  );
}
