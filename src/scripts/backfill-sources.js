const fs = require("fs");
const path = require("path");
const {
    MANIFEST_PATH,
    LEDGER_PATH,
    ledgerKey,
    extractSourceMetadata,
    buildLedgerEntry,
    loadLedger,
    saveLedger,
    describeWeakEntry,
    isStrongEntry,
    isSamePhoto,
    mergeSource,
    pruneLedgerSafely
} = require("./lib/photo-sources");

loadEnvFile();

const IMAGE_PATTERN = /\.(jpe?g|png|webp)$/i;
const PREVIEW_SUFFIX = "_preview";

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
    const defaults = {
        dir: process.env.R2_UPLOADS_DIR || "uploads",
        dryRun: false,
        overwrite: false,
        report: false,
        forcePrune: false
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
            case "--dry-run":
                parsed.dryRun = true;
                break;
            case "--overwrite":
                parsed.overwrite = true;
                break;
            case "--report":
                parsed.report = true;
                break;
            case "--force-prune":
                parsed.forcePrune = true;
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

    if (!parsed.dir) {
        throw new Error("--dir requires a path.");
    }

    return parsed;
}

function printUsage() {
    console.log(`
Usage: node src/scripts/backfill-sources.js [options]

Scans a folder of Lightroom exports and records where each site photo came from
in src/content/photo-sources.json.

Options:
  --dir, -d       Folder to scan recursively (default: R2_UPLOADS_DIR, or uploads)
  --dry-run       Show what would be recorded or removed without writing anything
  --overwrite     Re-read files that already have a ledger entry
  --report        Only report ledger coverage for the photos in the manifest (no scan)
  --force-prune   Prune the ledger even if that would remove more than half of it
  --help, -h      Show this help message
`);
}

// Returns { manifest, loaded }. `loaded` is false if the file is missing, empty or unparseable.
function loadManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) {
        console.warn(`[backfill-sources] Manifest not found at ${MANIFEST_PATH}.`);
        return { manifest: { portfolio: {}, events: {} }, loaded: false };
    }

    try {
        const raw = fs.readFileSync(MANIFEST_PATH, "utf-8").trim();
        if (!raw) {
            console.warn("[backfill-sources] Manifest is empty.");
            return { manifest: { portfolio: {}, events: {} }, loaded: false };
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("expected a JSON object");
        }
        return { manifest: parsed, loaded: true };
    } catch (err) {
        console.warn(`[backfill-sources] Failed to parse manifest at ${MANIFEST_PATH}: ${err.message}`);
        return { manifest: { portfolio: {}, events: {} }, loaded: false };
    }
}

// Flat list of every photo in the manifest.
function listManifestPhotos(manifest) {
    const photos = [];
    for (const [type, folders] of Object.entries(manifest)) {
        for (const [folder, entries] of Object.entries(folders || {})) {
            for (const entry of entries || []) {
                photos.push({
                    type,
                    folder,
                    filename: entry.filename,
                    key: ledgerKey(type, folder, entry.filename)
                });
            }
        }
    }
    return photos;
}

// Index manifest photos by filename stem so exports (.jpg) match their site entry (.webp).
function buildStemIndex(photos) {
    const index = new Map();
    for (const photo of photos) {
        const stem = path.basename(photo.filename, path.extname(photo.filename));
        if (!index.has(stem)) index.set(stem, []);
        index.get(stem).push(photo);
    }
    return index;
}

function collectImageFiles(root) {
    const files = [];
    const stack = [root];

    while (stack.length > 0) {
        const current = stack.pop();
        for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
            // Skip hidden files and macOS "._" resource forks.
            if (dirent.name.startsWith(".")) continue;
            const fullPath = path.join(current, dirent.name);
            if (dirent.isDirectory()) {
                stack.push(fullPath);
            } else if (dirent.isFile() && IMAGE_PATTERN.test(dirent.name)) {
                const stem = path.basename(dirent.name, path.extname(dirent.name));
                if (!stem.endsWith(PREVIEW_SUFFIX)) {
                    files.push(fullPath);
                }
            }
        }
    }

    return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Picks the manifest photo a file belongs to. With several same-stem candidates, the
// file's parent directories decide: first <type>/<folder>, then just <folder>.
// Returns { match } or { ambiguous: [candidates] }.
function resolveCandidates(candidates, filePath) {
    if (candidates.length === 1) {
        return { match: candidates[0] };
    }

    const parents = path.dirname(filePath).split(path.sep);
    const folderName = parents[parents.length - 1];
    const typeName = parents[parents.length - 2];

    let narrowed = candidates.filter(c => c.folder === folderName && c.type === typeName);
    if (narrowed.length === 0) {
        narrowed = candidates.filter(c => c.folder === folderName);
    }

    if (narrowed.length === 1) {
        return { match: narrowed[0] };
    }
    return { ambiguous: narrowed.length > 1 ? narrowed : candidates };
}

async function backfill(options, photos, ledger) {
    const root = path.resolve(process.cwd(), options.dir);
    if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) {
        throw new Error(`Scan directory not found: ${root}`);
    }

    const index = buildStemIndex(photos);
    const files = collectImageFiles(root);
    const stats = {
        scanned: files.length,
        recorded: 0,
        updated: 0,
        alreadyRecorded: 0,
        kept: 0,
        duplicates: 0,
        matchedByMetadata: 0,
        linkedCopies: 0,
        unmatched: 0,
        ambiguous: [],
        failed: []
    };
    const touched = new Set();
    const unmatchedFiles = [];

    console.log(`Scanning ${root} (${files.length} image file(s))`);

    for (const filePath of files) {
        const filename = path.basename(filePath);
        const stem = path.basename(filename, path.extname(filename));
        const candidates = index.get(stem);

        if (!candidates) {
            unmatchedFiles.push(filePath);
            continue;
        }

        const resolved = resolveCandidates(candidates, filePath);
        if (resolved.ambiguous) {
            stats.ambiguous.push({ filePath, candidates: resolved.ambiguous });
            continue;
        }

        const key = resolved.match.key;
        const existing = ledger[key];
        // Weak entries are always re-read, since a newer export may fill them in.
        if (existing && isStrongEntry(existing) && !touched.has(key) && !options.overwrite) {
            stats.alreadyRecorded += 1;
            continue;
        }

        let entry;
        try {
            entry = buildLedgerEntry(await extractSourceMetadata(filePath), filename);
        } catch (err) {
            stats.failed.push({ filePath, message: err.message });
            continue;
        }

        // Never replace an entry that traces to a raw file with one that doesn't.
        if (existing && isStrongEntry(existing) && !isStrongEntry(entry)) {
            stats.kept += 1;
            continue;
        }
        // A weak entry re-read without improvement stays as it is.
        if (existing && !touched.has(key) && !options.overwrite && !isStrongEntry(entry)) {
            stats.alreadyRecorded += 1;
            continue;
        }
        // A second export of the same photo only wins if it is the first to reach a raw file.
        if (existing && touched.has(key) && !(isStrongEntry(entry) && !isStrongEntry(existing))) {
            stats.duplicates += 1;
            continue;
        }

        ledger[key] = entry;
        touched.add(key);
        if (existing) {
            stats.updated += 1;
        } else {
            stats.recorded += 1;
        }

        const detail = isStrongEntry(entry) ? entry.rawFileName : describeWeakEntry(entry);
        console.log(`${options.dryRun ? "[dry-run] Would record" : "[record]"} ${key} <- ${detail}`);
    }

    await matchByMetadata(unmatchedFiles, photos, ledger, stats, options);
    linkCopies(photos, ledger, stats, options);

    return stats;
}

function weakPhotoKeys(photos, ledger) {
    return photos.map(photo => photo.key).filter(key => ledger[key] && !isStrongEntry(ledger[key]));
}

// Re-exports usually have new filenames, so files whose name matched nothing are compared
// to the weak entries by Lightroom document ID or exact capture time + camera instead.
async function matchByMetadata(files, photos, ledger, stats, options) {
    const weakKeys = weakPhotoKeys(photos, ledger);
    if (files.length === 0 || weakKeys.length === 0) {
        stats.unmatched = files.length;
        return;
    }

    const claimed = new Map();
    for (const filePath of files) {
        let metadata;
        try {
            metadata = await extractSourceMetadata(filePath);
        } catch (err) {
            stats.failed.push({ filePath, message: err.message });
            continue;
        }

        const targets = isStrongEntry(metadata)
            ? weakKeys.filter(key => !isStrongEntry(ledger[key]) && isSamePhoto(metadata, ledger[key]))
            : [];
        if (targets.length === 0) {
            stats.unmatched += 1;
            continue;
        }

        // Several targets are the same photo used in more than one gallery.
        for (const key of targets) {
            if (claimed.has(key)) {
                stats.duplicates += 1;
                continue;
            }
            claimed.set(key, filePath);
            ledger[key] = mergeSource(ledger[key], metadata);
            stats.matchedByMetadata += 1;
            console.log(
                `${options.dryRun ? "[dry-run] Would match" : "[match]"} ${key} <- ${metadata.rawFileName} (from ${path.basename(filePath)})`
            );
        }
    }
}

// A portfolio photo is often an export of an event photo that was imported back into
// Lightroom. When a weak entry is the same photo as a strong one, borrow its source.
function linkCopies(photos, ledger, stats, options) {
    const strong = photos.map(photo => photo.key).filter(key => isStrongEntry(ledger[key]));
    for (const key of weakPhotoKeys(photos, ledger)) {
        const source = strong.find(other => isSamePhoto(ledger[key], ledger[other]));
        if (!source) continue;
        ledger[key] = mergeSource(ledger[key], ledger[source]);
        stats.linkedCopies += 1;
        console.log(
            `${options.dryRun ? "[dry-run] Would link" : "[link]"} ${key} <- ${ledger[key].rawFileName} (same photo as ${source})`
        );
    }
}

function printScanSummary(stats, options) {
    console.log("\nScan summary");
    const recordedLabel = options.dryRun ? "Would record" : "Recorded";
    const updatedLabel = options.dryRun ? "Would update" : "Updated";
    console.log(`  Files scanned:            ${stats.scanned}`);
    console.log(`  ${recordedLabel}:`.padEnd(28) + stats.recorded);
    console.log(`  ${updatedLabel}:`.padEnd(28) + stats.updated);
    console.log(`  Already recorded:         ${stats.alreadyRecorded}`);
    console.log(`  Kept existing (better):   ${stats.kept}`);
    console.log(`  Matched by ID/time:       ${stats.matchedByMetadata}`);
    console.log(`  Linked to event copy:     ${stats.linkedCopies}`);
    console.log(`  Duplicate exports:        ${stats.duplicates}`);
    console.log(`  Not on the site:          ${stats.unmatched}`);
    console.log(`  Ambiguous:                ${stats.ambiguous.length}`);
    console.log(`  Unreadable:               ${stats.failed.length}`);

    if (stats.ambiguous.length > 0) {
        console.log("\nAmbiguous files (several site photos share this filename; not recorded):");
        for (const { filePath, candidates } of stats.ambiguous) {
            console.log(`  ${filePath}`);
            for (const candidate of candidates) {
                console.log(`      could be ${candidate.key}`);
            }
        }
        console.log("Put these exports under a <type>/<folder>/ directory matching the gallery and run again.");
    }

    if (stats.failed.length > 0) {
        console.log("\nCould not read metadata from:");
        for (const { filePath, message } of stats.failed) {
            console.log(`  ${filePath}: ${message}`);
        }
    }
}

function printReport(photos, ledger, options) {
    const withRaw = [];
    const weak = [];
    const missing = [];

    for (const photo of photos) {
        const entry = ledger[photo.key];
        if (!entry) {
            missing.push(photo);
            continue;
        }
        const weakness = describeWeakEntry(entry);
        if (weakness) {
            weak.push({ photo, weakness });
        } else {
            withRaw.push(photo);
        }
    }

    console.log("\nSource ledger report");
    console.log(`  Site photos:           ${photos.length}`);
    console.log(`  Traced to a raw file:  ${withRaw.length}`);
    console.log(`  Weak entries:          ${weak.length}`);
    console.log(`  No entry:              ${missing.length}`);

    if (weak.length > 0) {
        console.log("\nWeak entries:");
        for (const { photo, weakness } of weak) {
            console.log(`  ${photo.key} - ${weakness}`);
            const entry = ledger[photo.key];
            const details = [];
            if (entry.captureTime) details.push(`captured ${entry.captureTime.replace("T", " ")}`);
            if (entry.camera) details.push(`on ${entry.camera}`);
            if (entry.lens) details.push(`with ${entry.lens}`);
            if (details.length > 0) {
                console.log(`      ${details.join(" ")}`);
            }
        }
    }

    if (missing.length > 0) {
        console.log("\nNo entry:");
        for (const photo of missing) {
            console.log(`  ${photo.key}`);
        }
    }

    if (weak.length === 0 && missing.length === 0) {
        if (options.dryRun) {
            console.log("\nEvery site photo traces back to a raw file (dry run: nothing was written yet).");
        } else {
            console.log("\nEvery site photo traces back to a raw file. It is safe to delete the local originals.");
        }
    } else {
        console.log("\nNot safe to delete the local originals yet: keep them until the lists above are empty.");
        console.log(
            "To fix one, find it in Lightroom by capture time, export it with Metadata -> Include: All Metadata\n" +
                "(any filename), and run: npm run sources:backfill -- --dir <folder with those exports>"
        );
    }
}

async function main() {
    const options = parseArgs();
    const { manifest, loaded: manifestLoaded } = loadManifest();
    const ledger = loadLedger();

    // Prune first so the report and the scan work from the cleaned ledger. This also
    // runs for --report, and always against the full manifest.
    const pruned = pruneLedgerSafely(ledger, manifest, {
        manifestLoaded,
        dryRun: options.dryRun,
        force: options.forcePrune,
        tag: "backfill-sources"
    });

    if (!manifestLoaded) {
        throw new Error("Cannot continue without a valid manifest. Nothing was changed.");
    }

    const photos = listManifestPhotos(manifest);
    let stats = null;
    if (!options.report) {
        stats = await backfill(options, photos, ledger);
    }

    const changed = pruned.length > 0 || (stats !== null && stats.recorded + stats.updated + stats.matchedByMetadata + stats.linkedCopies > 0);
    if (!options.dryRun && changed) {
        saveLedger(ledger);
        console.log(`\nLedger written to ${LEDGER_PATH}`);
    }

    if (stats) {
        printScanSummary(stats, options);
    }
    if (pruned.length > 0) {
        console.log(`\nLedger entries ${options.dryRun ? "that would be removed" : "removed"}: ${pruned.length}`);
    }
    printReport(photos, ledger, options);

    if (options.dryRun) {
        console.log("\nDry run: the ledger was not written.");
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
