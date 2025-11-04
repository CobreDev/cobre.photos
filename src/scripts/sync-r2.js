const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const {
    S3Client,
    ListObjectsV2Command,
    PutObjectCommand
} = require("@aws-sdk/client-s3");

const CONTENT_ROOT = path.join(__dirname, "..", "content");
const MANIFEST_PATH = path.join(CONTENT_ROOT, "gallery-manifest.json");

loadEnvFile();

function loadEnvFile() {
    const envPath = path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        if (!(key in process.env)) {
            process.env[key] = value;
        }
    }
}

function parseArgs() {
    const defaultDir = process.env.R2_UPLOADS_DIR || "uploads";
    const defaults = {
        dir: defaultDir,
        dryRun: false
    };

    const args = process.argv.slice(2);
    const parsed = { ...defaults };

    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        switch (token) {
            case "--dir":
            case "-d":
                parsed.dir = args[++i];
                break;
            case "--type":
            case "-t":
                parsed.type = args[++i];
                break;
            case "--folder":
            case "-f":
                parsed.folder = args[++i];
                break;
            case "--dry-run":
                parsed.dryRun = true;
                break;
            case "--help":
            case "-h":
                printUsage();
                process.exit(0);
            default:
                if (token && token.startsWith("-")) {
                    throw new Error(`Unknown flag: ${token}`);
                }
        }
    }

    if (parsed.type && !["events", "portfolio"].includes(parsed.type)) {
        throw new Error("Invalid --type value. Expected 'events' or 'portfolio'.");
    }

    if (parsed.folder && !parsed.type) {
        throw new Error("--folder requires --type to be specified.");
    }

    return parsed;
}

function printUsage() {
    console.log(`
Usage: node src/scripts/sync-r2.js [options]

Options:
  --dir, -d       Path to the local staging directory (default: uploads)
  --type, -t      Limit sync to a single type (events | portfolio)
  --folder, -f    Limit sync to a specific gallery folder (requires --type)
  --dry-run       Show the operations without uploading or writing files
  --help, -h      Show this help message
`);
}

function loadConfig() {
    const config = {
        accountId: process.env.R2_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        bucketName: process.env.R2_BUCKET_NAME
    };

    const missing = Object.entries(config)
        .filter(([, value]) => !value)
        .map(([key]) => key);

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }

    return {
        ...config,
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`
    };
}

function loadManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) {
        return { portfolio: {}, events: {} };
    }

    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
}

function ensureManifestSection(manifest, type, folder) {
    if (!manifest[type]) manifest[type] = {};
    if (!manifest[type][folder]) manifest[type][folder] = [];
    return manifest[type][folder];
}

function collectLocalImages(directory) {
    if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) {
        return [];
    }

    return fs
        .readdirSync(directory)
        .filter(file => /\.(jpe?g|png)$/i.test(file))
        .filter(file => !path.basename(file, path.extname(file)).endsWith("_preview"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function readImageMetadata(filePath) {
    const metadata = await sharp(filePath).metadata();
    return {
        width: metadata.width,
        height: metadata.height,
        type: metadata.format === "jpeg" ? "jpg" : metadata.format
    };
}

function contentTypeForFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".png") return "image/png";
    return "application/octet-stream";
}

async function listRemoteKeys(client, bucket, prefix) {
    const keys = new Set();
    let continuationToken = undefined;

    do {
        const response = await client.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken
            })
        );

        (response.Contents || []).forEach(item => keys.add(item.Key));
        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
}

async function uploadOriginal(client, bucket, key, filePath) {
    const body = fs.createReadStream(filePath);
    await client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentTypeForFile(filePath),
            CacheControl: "public, max-age=31536000, immutable"
        })
    );
}

async function uploadPreview(client, bucket, key, filePath, type) {
    const resizeOptions =
        type === "events"
            ? { height: 400, fit: "inside", withoutEnlargement: true }
            : { width: 800, fit: "inside", withoutEnlargement: true };

    const buffer = await sharp(filePath)
        .resize(resizeOptions)
        .webp({
            quality: 80,
            effort: 6,
            lossless: false,
            smartSubsample: true
        })
        .toBuffer();

    await client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: "image/webp",
            CacheControl: "public, max-age=31536000, immutable"
        })
    );
}

function formatPrefix(type, folder) {
    return `content/${type}/${folder}/`;
}

function sortManifestSection(section) {
    section.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
}

async function processGallery(client, config, manifest, type, folder, directory, options, remoteCache) {
    const files = collectLocalImages(directory);
    if (files.length === 0) {
        console.log(`[skip] No source images found in ${directory}`);
        return { uploaded: 0, previews: 0, manifestUpdates: 0 };
    }

    const prefix = formatPrefix(type, folder);
    let remoteKeys = remoteCache.get(prefix);
    if (!remoteKeys) {
        remoteKeys = await listRemoteKeys(client, config.bucketName, prefix);
        remoteCache.set(prefix, remoteKeys);
    }

    const manifestSection = ensureManifestSection(manifest, type, folder);
    let uploaded = 0;
    let previews = 0;
    let manifestUpdates = 0;
    let manifestDirty = false;

    for (const filename of files) {
        const filePath = path.join(directory, filename);
        const baseName = path.basename(filename, path.extname(filename));
        const originalKey = `${prefix}${filename}`;
        const previewFilename = `${baseName}_preview.webp`;
        const previewKey = `${prefix}${previewFilename}`;

        const manifestEntry = manifestSection.find(entry => entry.filename === filename);
        const hasOriginalRemote = remoteKeys.has(originalKey);
        const hasPreviewRemote = remoteKeys.has(previewKey);

        if (manifestEntry && hasOriginalRemote && hasPreviewRemote) {
            console.log(`[skip] ${type}/${folder}/${filename} already synced`);
            continue;
        }

        let metadata = null;
        if (!manifestEntry || !manifestEntry.width || !manifestEntry.height || !manifestEntry.type) {
            metadata = await readImageMetadata(filePath);
        }

        if (!manifestEntry) {
            manifestSection.push({
                filename,
                width: metadata.width,
                height: metadata.height,
                type: metadata.type
            });
            manifestUpdates += 1;
            manifestDirty = true;
        } else if (metadata) {
            const originalWidth = manifestEntry.width;
            const originalHeight = manifestEntry.height;
            const originalType = manifestEntry.type;
            manifestEntry.width = manifestEntry.width || metadata.width;
            manifestEntry.height = manifestEntry.height || metadata.height;
            manifestEntry.type = manifestEntry.type || metadata.type;
            if (
                manifestEntry.width !== originalWidth ||
                manifestEntry.height !== originalHeight ||
                manifestEntry.type !== originalType
            ) {
                manifestDirty = true;
            }
        }

        if (!hasOriginalRemote) {
            if (options.dryRun) {
                console.log(`[dry-run] Would upload ${originalKey}`);
            } else {
                await uploadOriginal(client, config.bucketName, originalKey, filePath);
                console.log(`[upload] ${originalKey}`);
            }
            remoteKeys.add(originalKey);
            uploaded += 1;
        } else if (!manifestEntry) {
            console.log(`[note] ${originalKey} already exists remotely; metadata added to manifest only.`);
        }

        if (!hasPreviewRemote) {
            if (options.dryRun) {
                console.log(`[dry-run] Would generate preview ${previewKey}`);
            } else {
                await uploadPreview(client, config.bucketName, previewKey, filePath, type);
                console.log(`[preview] ${previewKey}`);
            }
            remoteKeys.add(previewKey);
            previews += 1;
        }
    }

    if (manifestUpdates > 0) {
        sortManifestSection(manifestSection);
    }

    return { uploaded, previews, manifestUpdates, manifestDirty };
}

async function main() {
    const options = parseArgs();
    const config = loadConfig();
    const stagingRoot = path.resolve(process.cwd(), options.dir);
    const manifest = loadManifest();

    const client = new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        }
    });

    if (!fs.existsSync(stagingRoot) || !fs.lstatSync(stagingRoot).isDirectory()) {
        throw new Error(`Staging directory not found: ${stagingRoot}`);
    }

    const typesToProcess = options.type ? [options.type] : ["portfolio", "events"];
    const summary = { uploaded: 0, previews: 0, manifestUpdates: 0 };
    let manifestChanged = false;
    const remoteCache = new Map();

    for (const type of typesToProcess) {
        const typeDir = path.join(stagingRoot, type);
        if (!fs.existsSync(typeDir) || !fs.lstatSync(typeDir).isDirectory()) {
            console.log(`[skip] No ${type} directory found under ${stagingRoot}`);
            continue;
        }

        const folders = fs
            .readdirSync(typeDir)
            .filter(name => {
                if (options.folder && type === options.type) {
                    return name === options.folder;
                }
                return true;
            })
            .filter(name => {
                const fullPath = path.join(typeDir, name);
                return fs.lstatSync(fullPath).isDirectory();
            })
            .sort();

        for (const folder of folders) {
            console.log(`\n==> Syncing ${type}/${folder}`);
            const galleryDir = path.join(typeDir, folder);
            const result = await processGallery(
                client,
                config,
                manifest,
                type,
                folder,
                galleryDir,
                options,
                remoteCache
            );

            summary.uploaded += result.uploaded;
            summary.previews += result.previews;
            summary.manifestUpdates += result.manifestUpdates;
            manifestChanged = manifestChanged || result.manifestDirty;
        }
    }

    if (!options.dryRun && manifestChanged) {
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
    }

    console.log("\nDone.");
    console.log(
        `Uploaded originals: ${summary.uploaded}\nGenerated previews: ${summary.previews}\nManifest entries added: ${summary.manifestUpdates}`
    );

    if (options.dryRun) {
        console.log("No files were uploaded and the manifest was not written because --dry-run was used.");
    } else if (manifestChanged) {
        console.log(`Manifest written to ${MANIFEST_PATH}`);
    } else {
        console.log("Manifest not changed.");
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
