const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const contentRoot = path.join(__dirname, "..", "content");
const OUTPUT_FILENAME = "gallery-manifest.json";
const IMAGE_PATTERN = /\.(jpe?g|png)$/i;
const PREVIEW_SUFFIX = "_preview";

function isDirectory(fullPath) {
    try {
        return fs.lstatSync(fullPath).isDirectory();
    } catch {
        return false;
    }
}

async function collectImagesFromFolder(folderPath) {
    if (!isDirectory(folderPath)) {
        return [];
    }

    const entries = [];

    for (const file of fs.readdirSync(folderPath)) {
        if (!IMAGE_PATTERN.test(file)) continue;

        const base = path.basename(file, path.extname(file));
        if (base.endsWith(PREVIEW_SUFFIX)) continue;

        const absolutePath = path.join(folderPath, file);
        const metadata = await sharp(absolutePath).metadata();

        entries.push({
            filename: file,
            width: metadata.width,
            height: metadata.height,
            type: metadata.format === "jpeg" ? "jpg" : metadata.format
        });
    }

    return entries.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
}

async function buildManifest() {
    const manifest = { portfolio: {}, events: {} };

    for (const category of Object.keys(manifest)) {
        const categoryPath = path.join(contentRoot, category);
        if (!isDirectory(categoryPath)) {
            continue;
        }

        for (const folder of fs.readdirSync(categoryPath)) {
            const folderPath = path.join(categoryPath, folder);
            if (!isDirectory(folderPath)) {
                continue;
            }

            const images = await collectImagesFromFolder(folderPath);
            manifest[category][folder] = images;
        }
    }

    return manifest;
}

async function main() {
    const manifest = await buildManifest();
    const outputPath = path.join(contentRoot, OUTPUT_FILENAME);
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Manifest written to ${outputPath}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
