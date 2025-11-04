const fs = require("fs");
const path = require("path");

let imageSize = null;
try {
    ({ imageSize } = require("image-size"));
} catch {
    imageSize = null;
}

loadEnvFile();

function loadEnvFile() {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
        return;
    }

    const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const sep = trimmed.indexOf("=");
        if (sep === -1) continue;
        const key = trimmed.slice(0, sep).trim();
        const value = trimmed.slice(sep + 1).trim();
        if (!(key in process.env)) {
            process.env[key] = value;
        }
    }
}

const CONTENT_ROOT = path.join("src", "content");
const MANIFEST_FILENAME = "gallery-manifest.json";
const MANIFEST_PATH = path.join(CONTENT_ROOT, MANIFEST_FILENAME);
const ASSET_BASE_URL = (process.env.PUBLIC_ASSET_BASE_URL || "").replace(/\/+$/, "");

function getImageFiles(folderPath) {
    return fs
        .readdirSync(folderPath)
        .filter(file => /\.(jpg|jpeg|png)$/i.test(file))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function readGlobalMeta() {
    const metaPath = path.join(CONTENT_ROOT, "meta.json");
    if (fs.existsSync(metaPath)) {
        return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    }
    return { portfolio: [], events: [] };
}

function buildPublicUrl(key) {
    const normalizedKey = key.replace(/^\/+/, "");
    if (!normalizedKey) {
        return ASSET_BASE_URL || "/";
    }
    if (!ASSET_BASE_URL) {
        return `/${normalizedKey}`;
    }
    return `${ASSET_BASE_URL}/${normalizedKey}`;
}

function getImageMeta(filePath, publicPath) {
    if (!imageSize) {
        throw new Error(
            "image-size is required to gather gallery metadata from the local filesystem, but it could not be loaded. " +
            "Install the dependency or provide a gallery manifest."
        );
    }
    const buffer = fs.readFileSync(filePath);
    const { width, height, type } = imageSize(buffer);
    return {
        filename: path.basename(filePath),
        url: buildPublicUrl(publicPath),
        width,
        height,
        type
    };
}

function buildGalleryEntry(type, entry, images, extra = {}) {
    if (!images || images.length === 0) {
        return null;
    }

    const infoByFilename = new Map(images.map(image => [image.filename, image]));

    let previewFilename = entry.preview;
    if (previewFilename && !infoByFilename.has(previewFilename)) {
        previewFilename = null;
    }
    if (!previewFilename && images.length > 0) {
        previewFilename = images[0].filename;
    }

    return {
        type,
        path: `/${entry.folder}/`,
        images,
        title: entry.title,
        description: entry.description || "",
        preview: previewFilename
            ? buildPublicUrl(`content/${type}/${entry.folder}/${previewFilename}`)
            : null,
        ...extra
    };
}

function buildGalleriesFromManifest(meta) {
    if (!fs.existsSync(MANIFEST_PATH)) {
        return null;
    }

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    const galleries = [];

    meta.portfolio
        .filter(entry => entry.visible !== false)
        .forEach(entry => {
            const files = manifest.portfolio?.[entry.folder] || [];
            const images = files.map(image => ({
                filename: image.filename,
                url: buildPublicUrl(`content/portfolio/${entry.folder}/${image.filename}`),
                width: image.width,
                height: image.height,
                type: image.type || path.extname(image.filename).slice(1)
            }));

            const gallery = buildGalleryEntry("portfolio", entry, images);
            if (gallery) {
                galleries.push(gallery);
            }
        });

    meta.events
        .filter(entry => entry.visible !== false)
        .forEach(entry => {
            const files = manifest.events?.[entry.folder] || [];
            const images = files.map(image => ({
                filename: image.filename,
                url: buildPublicUrl(`content/events/${entry.folder}/${image.filename}`),
                width: image.width,
                height: image.height,
                type: image.type || path.extname(image.filename).slice(1)
            }));

            const gallery = buildGalleryEntry("events", entry, images, {
                short_title: entry.short_title || entry.title,
                location: entry.location || "",
                date: entry.date || null
            });

            if (gallery) {
                galleries.push(gallery);
            }
        });

    return galleries;
}

function buildGalleriesFromFilesystem(meta) {
    const galleries = [];

    meta.portfolio
        .filter(entry => entry.visible !== false)
        .forEach(entry => {
            const folderPath = path.join(CONTENT_ROOT, "portfolio", entry.folder);
            if (fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory()) {
                const images = getImageFiles(folderPath).map(file =>
                    getImageMeta(
                        path.join(folderPath, file),
                        `/content/portfolio/${entry.folder}/${file}`
                    )
                );

                const gallery = buildGalleryEntry("portfolio", entry, images);
                if (gallery) {
                    galleries.push(gallery);
                }
            }
        });

    meta.events
        .filter(entry => entry.visible !== false)
        .forEach(entry => {
            const folderPath = path.join(CONTENT_ROOT, "events", entry.folder);
            if (fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory()) {
                const images = getImageFiles(folderPath).map(file =>
                    getImageMeta(
                        path.join(folderPath, file),
                        `/content/events/${entry.folder}/${file}`
                    )
                );

                const gallery = buildGalleryEntry("events", entry, images, {
                    short_title: entry.short_title || entry.title,
                    location: entry.location || "",
                    date: entry.date || null
                });

                if (gallery) {
                    galleries.push(gallery);
                }
            }
        });

    return galleries;
}

function getGalleries() {
    const meta = readGlobalMeta();
    const manifestGalleries = buildGalleriesFromManifest(meta);
    if (manifestGalleries) {
        return manifestGalleries;
    }
    return buildGalleriesFromFilesystem(meta);
}

function groupEventsByMonth(galleries) {
    const events = galleries.filter(g => g.type === "events");
    const grouped = {};

    events.forEach(event => {
        const eventDate = event.date && event.date.start ? new Date(event.date.start) : new Date(event.date);
        const key = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, "0")}-15`;

        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(event);
    });

    return Object.entries(grouped)
        .map(([month, items]) => ({ month, items }))
        .sort((a, b) => (a.month < b.month ? 1 : -1));
}

function groupEventsByYear(galleries) {
    const events = galleries.filter(g => g.type === "events");
    const grouped = {};

    events.forEach(event => {
        const eventDate = event.date && event.date.start ? new Date(event.date.start) : new Date(event.date);
        const key = String(eventDate.getFullYear());

        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(event);
    });

    return Object.entries(grouped)
        .map(([year, items]) => ({ year, items }))
        .sort((a, b) => (a.year < b.year ? 1 : -1));
}

const galleries = getGalleries();
const eventsByMonth = groupEventsByMonth(galleries);
const eventsByYear = groupEventsByYear(galleries);

module.exports = {
    galleries,
    eventsByMonth,
    eventsByYear
};
