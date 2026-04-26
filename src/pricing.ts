import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AscClient } from "./client.js";

function text(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

export function registerPricingTools(server: McpServer, client: AscClient) {
  server.registerTool(
    "appstore_list_price_points",
    {
      description:
        "List App Store price points available for an app in a given territory. Returns price point IDs (for use with appstore_set_app_price) along with the customer-facing price and developer proceeds. The cheapest point (customerPrice 0.00) is the FREE tier. Apple deprecated the legacy `priceTier` relationship, so results are filtered/sorted client-side here. Pass `customerPrice` to find a specific tier (e.g. \"4.99\").",
      inputSchema: {
        appId: z.string(),
        territory: z
          .string()
          .default("USA")
          .describe(
            "ISO 3166 alpha-3 territory code, e.g. USA, FRA, GBR, JPN. Defaults to USA.",
          ),
        customerPrice: z
          .string()
          .optional()
          .describe(
            "Filter to a specific customer price (string match, e.g. \"4.99\" or \"0.00\"). Applied client-side.",
          ),
        limit: z.number().int().min(1).max(8000).optional(),
      },
    },
    async ({ appId, territory, customerPrice, limit }) => {
      // Apple caps page size at 200 on /apps/{id}/appPricePoints. Paginate
      // until we either hit `limit` results, find an exact customerPrice
      // match, or exhaust the cursor.
      const pageSize = 200;
      const target = limit ?? 1500;
      const collected: Array<{
        id: string;
        customerPrice?: string;
        proceeds?: string;
        territoryId?: string;
      }> = [];
      let cursor: string | undefined;
      while (collected.length < target) {
        const query: Record<string, string | number> = {
          "filter[territory]": territory,
          limit: pageSize,
        };
        if (cursor) query["cursor"] = cursor;
        const page = await client.get<{
          data: any[];
          links?: { next?: string };
        }>(`/apps/${appId}/appPricePoints`, query);
        for (const p of page.data) {
          collected.push({
            id: p.id,
            customerPrice: p.attributes?.customerPrice,
            proceeds: p.attributes?.proceeds,
            territoryId: p.relationships?.territory?.data?.id,
          });
        }
        if (
          customerPrice &&
          collected.some((c) => String(c.customerPrice) === customerPrice)
        ) {
          break;
        }
        const next = page.links?.next;
        if (!next || page.data.length < pageSize) break;
        const m = next.match(/[?&]cursor=([^&]+)/);
        cursor = m ? decodeURIComponent(m[1]) : undefined;
        if (!cursor) break;
      }
      const points = collected
        .filter((p) =>
          customerPrice ? String(p.customerPrice) === customerPrice : true,
        )
        .sort(
          (a, b) =>
            parseFloat(a.customerPrice ?? "0") -
            parseFloat(b.customerPrice ?? "0"),
        );
      return text(points);
    },
  );

  server.registerTool(
    "appstore_get_app_price_schedule",
    {
      description:
        "Get the current price schedule for an app: base territory, automatic prices (auto-converted from base) and manual prices (developer-set, with start dates).",
      inputSchema: { appId: z.string() },
    },
    async ({ appId }) => {
      try {
        const data = await client.get<{ data: any; included?: any[] }>(
          `/apps/${appId}/appPriceSchedule`,
          {
            include: "baseTerritory,manualPrices,automaticPrices",
          },
        );
        if (!data?.data) return text({ found: false });
        const included = data.included ?? [];
        const prices = included
          .filter((r: any) => r.type === "appPrices")
          .map((r: any) => ({
            id: r.id,
            startDate: r.attributes?.startDate ?? null,
            endDate: r.attributes?.endDate ?? null,
            manual: r.attributes?.manual ?? null,
            pricePointId: r.relationships?.appPricePoint?.data?.id,
            territoryId: r.relationships?.territory?.data?.id,
          }));
        return text({
          id: data.data.id,
          baseTerritoryId:
            data.data.relationships?.baseTerritory?.data?.id ?? null,
          manualPriceIds: (
            data.data.relationships?.manualPrices?.data ?? []
          ).map((p: any) => p.id),
          automaticPriceIds: (
            data.data.relationships?.automaticPrices?.data ?? []
          ).map((p: any) => p.id),
          prices,
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
    "appstore_set_app_price",
    {
      description:
        "Create a new price schedule for an app. Replaces any existing schedule. Pass `pricePointId` (resolved via appstore_list_price_points) and optionally a `startDate` for a scheduled change. The price in the chosen base territory automatically translates to other territories. Pass `pricePointId: null` is NOT supported by Apple — to make the app free, look up the FREE tier (customerPrice 0) via appstore_list_price_points and pass its ID.",
      inputSchema: {
        appId: z.string(),
        pricePointId: z
          .string()
          .describe(
            "App price point ID for the desired tier. Discover via appstore_list_price_points.",
          ),
        baseTerritory: z
          .string()
          .default("USA")
          .describe(
            "ISO 3166 alpha-3 territory code used as the reference for auto-conversion. Defaults to USA.",
          ),
        startDate: z
          .string()
          .optional()
          .describe(
            "ISO 8601 datetime for the price to take effect. Omit to apply immediately.",
          ),
      },
    },
    async ({ appId, pricePointId, baseTerritory, startDate }) => {
      // Apple's JSON:API inline-creation requires local IDs of the form
      // `${something}` — the literal `${}` wrapping is mandatory.
      const priceClientId = `\${price-${randomUUID()}}`;
      const payload = {
        data: {
          type: "appPriceSchedules",
          relationships: {
            app: { data: { type: "apps", id: appId } },
            baseTerritory: {
              data: { type: "territories", id: baseTerritory },
            },
            manualPrices: {
              data: [{ type: "appPrices", id: priceClientId }],
            },
          },
        },
        included: [
          {
            type: "appPrices",
            id: priceClientId,
            attributes: startDate ? { startDate } : {},
            relationships: {
              appPricePoint: {
                data: { type: "appPricePoints", id: pricePointId },
              },
            },
          },
        ],
      };
      const res = await client.post<{ data: any }>(
        "/appPriceSchedules",
        payload,
      );
      return text({
        scheduleId: res.data.id,
        appId,
        baseTerritory,
        pricePointId,
        startDate: startDate ?? null,
      });
    },
  );
}
