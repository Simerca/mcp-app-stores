# mcp-app-stores

MCP server to manage your iOS and Android apps from Claude or any MCP client. Read & edit **App Store Connect** and **Google Play Console** listings — titles, descriptions, keywords, promotional text, screenshots, previews, release tracks — without leaving the chat.

- 🍎 **App Store Connect** — full ASO metadata, screenshots, app previews, review submission
- 🤖 **Google Play** — store listings (title/short/full description), images, release tracks, rollout control
- 🔁 **Unified tools** — one call to list apps across both stores or push ASO copy to both at once

## Features

### App Store Connect
- List apps, list/create versions, find the current editable version
- Edit version localizations (description 4000, keywords 100, promoText 170, whatsNew 4000, URLs)
- Edit app-level name & subtitle per locale
- Upload/delete/reorder screenshots and app previews
- Submit version for review

### Google Play
- Read/update localized store listings (title 30, short desc 80, full desc 4000)
- Upload, list and delete graphic assets (icon, feature graphic, phone/tablet/TV/wearable screenshots)
- Read track state (production, beta, alpha, custom), update release notes, control staged rollout

### Unified
- `list_all_apps` — everything you own across both stores
- `list_product_keys` — product keys from your `apps.json`
- `get_aso_snapshot` — side-by-side ASO copy for a product × locale
- `update_aso_common` — push title/short/long description to both stores in one call

## Install

```bash
git clone https://github.com/<your-user>/mcp-app-stores.git
cd mcp-app-stores
npm install
npm run build
```

## Credentials

Both stores are optional — configure only the ones you need. If neither is set the server exits with an error.

### App Store Connect

1. **App Store Connect** → *Users and Access* → *Integrations* → *App Store Connect API* → generate a key (role: *App Manager* or higher).
2. Download the `.p8` private key. You can't re-download it later.
3. Store it outside your repo with restricted permissions:
   ```bash
   mkdir -p ~/.appstore
   mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/.appstore/
   chmod 600 ~/.appstore/AuthKey_XXXXXXXXXX.p8
   ```
4. Note the **Key ID** (short alphanumeric) and **Issuer ID** (UUID) shown in the Integrations page.

### Google Play

1. **Google Cloud Console** → create/pick a project → enable the **Google Play Android Developer API**.
2. *IAM* → *Service Accounts* → create a service account → *Keys* → *Add Key → JSON*. Download the JSON.
3. **Play Console** → *Users and permissions* → invite the service account's email → grant access to the app(s) you want to manage (e.g. *View app information*, *Manage store presence*).
4. Store the JSON outside your repo:
   ```bash
   mv ~/Downloads/<project>-<hash>.json ~/.appstore/
   chmod 600 ~/.appstore/<project>-<hash>.json
   ```

### Environment

Copy `.env.example` to `.env` (or pass env vars directly when wiring the MCP server):

```bash
# App Store Connect
ASC_KEY_ID=ABCD123456
ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
ASC_PRIVATE_KEY_PATH=~/.appstore/AuthKey_ABCD123456.p8

# Google Play
GOOGLE_SERVICE_ACCOUNT_JSON_PATH=~/.appstore/my-service-account.json
```

### Product key mapping (`apps.json`)

Unified tools use a product key → store ID map. Copy [`apps.example.json`](apps.example.json) to one of:

- `./apps.json` (project root), or
- `~/.mcp-app-stores/apps.json`, or
- any path you point to with `APPS_MAPPING_PATH`

```json
{
  "myapp": {
    "appstore": { "appId": "1234567890" },
    "playstore": { "packageName": "com.example.myapp" }
  }
}
```

Every key is optional — you can omit a store for apps that don't ship there.

## Use with Claude Code

Add to `.mcp.json` at project root (or `~/.claude.json`):

```json
{
  "mcpServers": {
    "app-stores": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-app-stores/dist/index.js"],
      "env": {
        "ASC_KEY_ID": "ABCD123456",
        "ASC_ISSUER_ID": "00000000-0000-0000-0000-000000000000",
        "ASC_PRIVATE_KEY_PATH": "~/.appstore/AuthKey_ABCD123456.p8",
        "GOOGLE_SERVICE_ACCOUNT_JSON_PATH": "~/.appstore/my-service-account.json"
      }
    }
  }
}
```

During dev without a build step:

```json
{
  "command": "npx",
  "args": ["tsx", "/absolute/path/to/mcp-app-stores/src/index.ts"]
}
```

## Tools

### App Store (prefix `appstore_`)

**Apps & versions**
- `appstore_list_apps`, `appstore_get_app`
- `appstore_list_app_versions` — all versions, any state
- `appstore_find_editable_version` — find the current PREPARE_FOR_SUBMISSION or rejected version — **call before editing**
- `appstore_create_app_version` — create a new version to unlock editing
- `appstore_update_version` — copyright, releaseType (MANUAL / AFTER_APPROVAL / SCHEDULED), earliestReleaseDate, versionString, usesIdfa
- `appstore_list_builds` — uploaded builds for an app (newest first), filterable by platform / preReleaseVersion / processingState
- `appstore_attach_build` — bind a build (uploaded via Xcode/Transporter/fastlane) to an editable App Store version (or detach with `buildId: null`)

**Version localizations (ASO copy)**
- `appstore_list_version_localizations`, `appstore_get_version_localization`
- `appstore_update_version_localization` — description, keywords, promotionalText, whatsNew, URLs
- `appstore_create_version_localization` — add a new locale

**App-level metadata**
- `appstore_list_app_info_localizations`
- `appstore_update_app_info_localization` — name (30), subtitle (30), privacyPolicyUrl
- `appstore_get_app_info` — read editable AppInfo (state, age rating, categories)
- `appstore_update_app` — patches the App resource. Use it for `contentRightsDeclaration` (USES_THIRD_PARTY_CONTENT / DOES_NOT_USE_THIRD_PARTY_CONTENT)
- `appstore_list_app_categories` — discover category IDs
- `appstore_set_app_categories` — primary/secondary category + subcategories (single PATCH on the AppInfo)

**Age rating**
- `appstore_get_age_rating` — fetch the questionnaire ID + current answers
- `appstore_update_age_rating` — answer the questionnaire (frequency enums, gambling, unrestrictedWebAccess, kidsAgeBand, …)

**Privacy Nutrition Label**
- `appstore_list_data_usages` — current data-usage declarations
- `appstore_delete_data_usage` — remove one declaration
- `appstore_get_data_usage_publish_state` / `appstore_publish_data_usages` — manage published state
- `appstore_declare_no_data_collected` — one-shot helper for apps that collect zero data: deletes all declarations + publishes

**Pricing**
- `appstore_list_price_points` — discover tier IDs + customer prices for a territory (default USA). The tier with `customerPrice: "0.00"` is the FREE tier.
- `appstore_get_app_price_schedule` — current schedule (base territory, manual + automatic prices)
- `appstore_set_app_price` — create a new schedule with a chosen tier (immediate or `startDate`-scheduled)

**App Review Information**
- `appstore_get_review_details` — read contact info, demo account, notes
- `appstore_update_review_details` — create or patch review details (auto-creates if needed when `versionId` is given)
- `appstore_list_review_attachments`, `appstore_upload_review_attachment` (screen recording, PDF, etc.), `appstore_delete_review_attachment`

**Screenshots**
- `appstore_list_screenshot_sets`, `appstore_create_screenshot_set` — one set per display type (APP_IPHONE_67, APP_IPAD_PRO_3GEN_129, …)
- `appstore_list_screenshots`, `appstore_upload_screenshot` (auto reserve/upload/commit with MD5), `appstore_delete_screenshot`, `appstore_reorder_screenshots`

**App previews (video)**
- `appstore_list_app_preview_sets`, `appstore_create_app_preview_set`
- `appstore_list_app_previews`, `appstore_upload_app_preview` (mp4/m4v/mov, 30 s / 500 MB), `appstore_delete_app_preview`

**Submission**
- `appstore_submit_version_for_review` — full `reviewSubmissions` flow
- `appstore_list_review_submissions`

### Google Play (prefix `playstore_`)

- `playstore_get_app` — country availability, contact info
- `playstore_list_listings`, `playstore_get_listing`, `playstore_update_listing` — title (30), short description (80), full description (4000), promo video
- `playstore_list_images`, `playstore_upload_image`, `playstore_delete_image`, `playstore_delete_all_images` — icon, feature graphic, phone/tablet/TV/wearable screenshots
- `playstore_list_tracks`, `playstore_get_track` — production, beta, alpha, custom
- `playstore_update_release_notes`, `playstore_set_rollout` — staged rollout fraction, halt, resume
- `playstore_publish_bundle` — upload an `.aab` and push it to a track in one shot (creates edit, uploads, updates track, commits)
- `playstore_publish_apk` — same flow for legacy APK distribution

### Unified

- `list_all_apps` — App Store (via ASC) + Play (via `apps.json`)
- `list_product_keys` — keys from your `apps.json`
- `get_aso_snapshot` — read both stores' ASO copy for one product × locale
- `update_aso_common` — push title + short + long description to both stores in one call

## ASO field limits

| Store | Field | Max |
|-------|-------|-----|
| App Store | name | 30 |
| App Store | subtitle | 30 |
| App Store | keywords | 100 (comma-sep, no spaces after commas) |
| App Store | promotionalText | 170 |
| App Store | description | 4000 |
| App Store | whatsNew | 4000 |
| Play | title | 30 |
| Play | shortDescription | 80 |
| Play | fullDescription | 4000 |

On App Store, `promotionalText` is the only field editable while the version is live — everything else requires an editable version.

## Typical ASO workflow

1. `list_all_apps` → pick the app (or use `list_product_keys` for unified tools)
2. *Apple:* `appstore_find_editable_version` → grab `versionId` (`appstore_create_app_version` if none)
3. `appstore_list_version_localizations` → pick the locale's localization `id`
4. `appstore_update_version_localization` → push description/keywords/promo text
5. `appstore_update_app_info_localization` → push name + subtitle (app-level, not version-scoped)
6. *Google:* `playstore_update_listing` — changes are committed atomically (edits are created, patched, committed in one call)
7. Or use `update_aso_common` to do steps 4 + 6 at once

## Security

- `.p8` and the Play service-account JSON are **secrets**. Treat them like passwords.
- Keep them outside the repo (recommended: `~/.appstore/`), `chmod 600`.
- The Apple key ID and issuer ID alone are not credentials but still don't belong in a public repo.
- The server re-signs short-lived JWTs in memory; secrets are never logged.
- `apps.json` is git-ignored by default. Use `apps.example.json` as a template.

## Development

```bash
npm run dev        # run with tsx, no build step
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit
```

Source layout:

```
src/
  index.ts          # MCP server entry point
  auth.ts           # ASC JWT signing
  client.ts         # ASC REST client
  tools.ts          # appstore_* tools (apps, versions, localizations)
  media.ts          # appstore_* tools (screenshots, previews)
  submission.ts     # appstore_* tools (review submission)
  review.ts         # appstore_* tools (App Review Information + attachments)
  appinfo.ts        # appstore_* tools (categories, age rating, content rights)
  pricing.ts        # appstore_* tools (price points, schedules)
  privacy.ts        # appstore_* tools (Privacy Nutrition Label)
  gp-auth.ts        # Google Play OAuth2 from service account
  gp-client.ts      # Play Publishing API client
  gp-tools.ts       # playstore_* tools
  mapping.ts        # apps.json loader
  unified.ts        # cross-store tools
```

## Contributing

PRs welcome. When adding a tool, keep the `appstore_` / `playstore_` naming convention and keep store-specific logic out of `unified.ts`.

## License

MIT — see [LICENSE](LICENSE).
