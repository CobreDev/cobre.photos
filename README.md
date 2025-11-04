# cobre.photos

My photography portfolio

## Contact

- [Email](mailto:cooper@cobre.photos)
- [Instagram](https://instagram.com/cobre.photos)

## Credit
This site is based off of [pbsv.photo](https://pbsv.photo), the portfolio site of a photographer friend. He graciously allowed me to fork [his code](https://github.com/pbossev/pbsv.photo/) and use it for myself. Thanks!

## Environment

Copy `.env.example` to `.env` and fill in your Cloudflare R2 credentials plus the public base URL for image assets:

```
PUBLIC_ASSET_BASE_URL=https://cdn.example.com
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_UPLOADS_DIR=uploads
```

`PUBLIC_ASSET_BASE_URL` is used at build time so Eleventy points to the R2 bucket instead of local files. When omitted the build falls back to `/content/...`, which only works if images still live in the repository.

## R2 Workflow

1. Stage new images inside `R2_UPLOADS_DIR/<type>/<folder>/` where `<type>` is `events` or `portfolio` and `<folder>` matches the entry in `src/content/meta.json`. You only need to include the files you want to add—previous images stay in R2.
2. Run `npm run sync:r2` (or `node src/scripts/sync-r2.js`). The script will:
   - Upload originals that are missing in R2.
   - Generate and upload previews when they are absent.
   - Update `src/content/gallery-manifest.json` with width, height, and file info so the site builds without requiring local originals.
3. Commit the updated manifest and metadata changes. The images themselves stay out of git.

> [!TIP]
> Use `--dry-run` to check what would be uploaded before actually syncing, and `--type/--folder` to narrow down a run:
> ```
> npm run sync:r2 -- --dry-run --type events --folder 2025-10-17-wings-over-north-georgia
> ```

If you keep your upload staging area elsewhere, set `R2_UPLOADS_DIR` in `.env` (e.g. `R2_UPLOADS_DIR=./cobre.dev/uploads`) so the sync script picks it up automatically.

If you still have the full local catalog, you can backfill the manifest once with:

```
npm run build:manifest
```

After the manifest exists you can safely delete the local `src/content/events` and `src/content/portfolio` images from git—the build uses the manifest instead.
