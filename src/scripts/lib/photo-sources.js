const fs = require("fs");
const path = require("path");
const exifr = require("exifr");

const LEDGER_PATH = path.join(__dirname, "..", "..", "content", "photo-sources.json");
const MANIFEST_PATH = path.join(__dirname, "..", "..", "content", "gallery-manifest.json");

// Field order used when writing entries, so diffs stay predictable.
const ENTRY_FIELDS = [
    "rawFileName",
    "captureTime",
    "camera",
    "serial",
    "lens",
    "documentId",
    "exportedAs",
    "recordedAt"
];

// GPS is deliberately never requested. Everything else is limited to the blocks
// that hold the fields above.
const EXIFR_OPTIONS = {
    tiff: true,
    ifd0: true,
    exif: true,
    xmp: true,
    gps: false,
    interop: false,
    ifd1: false,
    iptc: false,
    icc: false,
    jfif: false,
    ihdr: false,
    mergeOutput: false,
    translateKeys: true,
    translateValues: false,
    reviveValues: false
};

function ensureWebpFilename(filename) {
    const ext = path.extname(filename);
    if (ext.toLowerCase() === ".webp") {
        return filename;
    }
    return `${path.basename(filename, ext)}.webp`;
}

function ledgerKey(type, folder, filename) {
    return `${type}/${folder}/${ensureWebpFilename(filename)}`;
}

function cleanString(value) {
    if (value === undefined || value === null) return undefined;
    const text = String(value).replace(/\0/g, "").trim();
    return text || undefined;
}

function pad(value, length) {
    return String(value).padStart(length, "0");
}

// Accepts "2025:10:17 14:03:22" (EXIF) or an ISO 8601 string (XMP) and returns
// the pieces we need, without ever going through a Date so no timezone is invented.
function splitDateTime(value) {
    if (value instanceof Date) {
        return null;
    }
    const text = cleanString(value);
    if (!text) return null;

    const match = text.match(
        /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/
    );
    if (!match) return null;

    return {
        date: `${match[1]}-${match[2]}-${match[3]}`,
        time: `${match[4]}:${match[5]}:${match[6]}`,
        fraction: match[7],
        offset: match[8]
    };
}

function normalizeOffset(offset) {
    const text = cleanString(offset);
    if (!text) return undefined;
    if (text === "Z") return "Z";
    const match = text.match(/^([+-])(\d{2}):?(\d{2})$/);
    return match ? `${match[1]}${match[2]}:${match[3]}` : undefined;
}

function buildCaptureTime(exifBlock, xmpBlocks) {
    const exifDate = splitDateTime(exifBlock.DateTimeOriginal);
    if (exifDate) {
        const subSec = cleanString(exifBlock.SubSecTimeOriginal);
        const fraction = subSec && /^\d+$/.test(subSec) ? subSec : exifDate.fraction;
        const offset = normalizeOffset(exifBlock.OffsetTimeOriginal) || normalizeOffset(exifDate.offset);
        return `${exifDate.date}T${exifDate.time}${fraction ? `.${fraction}` : ""}${offset || ""}`;
    }

    // Fall back to XMP: exif:DateTimeOriginal, then photoshop:DateCreated, then xmp:CreateDate.
    const candidates = [
        xmpBlocks.exif && xmpBlocks.exif.DateTimeOriginal,
        xmpBlocks.photoshop && xmpBlocks.photoshop.DateCreated,
        xmpBlocks.xmp && xmpBlocks.xmp.CreateDate
    ];
    for (const candidate of candidates) {
        const parts = splitDateTime(candidate);
        if (parts) {
            return `${parts.date}T${parts.time}${parts.fraction ? `.${parts.fraction}` : ""}${
                normalizeOffset(parts.offset) || ""
            }`;
        }
    }
    return undefined;
}

// "NIKON CORPORATION" + "NIKON Z 8" -> "NIKON Z 8"; "SONY" + "ILCE-1" -> "SONY ILCE-1".
function buildCamera(make, model) {
    const cleanMake = cleanString(make);
    const cleanModel = cleanString(model);
    if (!cleanMake) return cleanModel;
    if (!cleanModel) return cleanMake;

    const makeWord = cleanMake.split(/\s+/)[0].toLowerCase();
    if (cleanModel.toLowerCase().startsWith(makeWord)) {
        return cleanModel;
    }
    return `${cleanMake} ${cleanModel}`;
}

function buildDocumentId(xmpMM) {
    if (!xmpMM) return undefined;
    const derived = xmpMM.DerivedFrom;
    const fromDerived =
        derived && typeof derived === "object"
            ? derived.originalDocumentID || derived.documentID
            : undefined;
    return cleanString(fromDerived) || cleanString(xmpMM.OriginalDocumentID);
}

// Pure mapping from exifr's per-block output to our fields. Missing fields are omitted.
function mapSourceMetadata(parsed) {
    if (!parsed) return {};

    const exifBlock = parsed.exif || {};
    const ifd0 = parsed.ifd0 || {};
    const crs = parsed.crs || {};
    const aux = parsed.aux || {};

    const result = {
        // Some Lightroom exports omit crs:RawFileName but still carry the original
        // camera filename as xmpMM:PreservedFileName.
        rawFileName: cleanString(crs.RawFileName) || cleanString(parsed.xmpMM && parsed.xmpMM.PreservedFileName),
        captureTime: buildCaptureTime(exifBlock, parsed),
        camera: buildCamera(ifd0.Make, ifd0.Model),
        serial: cleanString(exifBlock.SerialNumber) || cleanString(exifBlock.BodySerialNumber) || cleanString(aux.SerialNumber),
        lens: cleanString(exifBlock.LensModel) || cleanString(aux.Lens),
        documentId: buildDocumentId(parsed.xmpMM)
    };

    for (const key of Object.keys(result)) {
        if (result[key] === undefined) delete result[key];
    }
    return result;
}

// JPEG metadata (EXIF, XMP, ICC) always sits before the image data, so only the start of
// the file needs reading. That matters when scanning tens of gigabytes of exports.
const JPEG_HEAD_BYTES = 2 * 1024 * 1024;

// exifr's own file reader breaks on newer Node versions, so read the bytes here and hand
// it a Buffer instead.
function readFileHead(filePath) {
    const fd = fs.openSync(filePath, "r");
    try {
        const isJpeg = /\.jpe?g$/i.test(filePath);
        const size = isJpeg ? Math.min(fs.fstatSync(fd).size, JPEG_HEAD_BYTES) : fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
            const bytesRead = fs.readSync(fd, buffer, offset, size - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        return buffer.subarray(0, offset);
    } finally {
        fs.closeSync(fd);
    }
}

async function extractSourceMetadata(filePath) {
    const parsed = await exifr.parse(readFileHead(filePath), EXIFR_OPTIONS);
    return mapSourceMetadata(parsed);
}

function todayString() {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}

function buildLedgerEntry(metadata, exportedAs) {
    return { ...metadata, exportedAs, recordedAt: todayString() };
}

function loadLedger() {
    if (!fs.existsSync(LEDGER_PATH)) {
        return {};
    }

    const raw = fs.readFileSync(LEDGER_PATH, "utf-8").trim();
    if (!raw) {
        return {};
    }

    // A ledger that exists but can't be read is an error: carrying on with a blank
    // one would overwrite the real data when it is saved.
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Failed to parse ${LEDGER_PATH}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${LEDGER_PATH} must contain a JSON object.`);
    }
    return parsed;
}

function saveLedger(ledger) {
    const sorted = {};
    for (const key of Object.keys(ledger).sort()) {
        const entry = ledger[key];
        const ordered = {};
        for (const field of ENTRY_FIELDS) {
            if (entry[field] !== undefined) ordered[field] = entry[field];
        }
        sorted[key] = ordered;
    }
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(sorted, null, 2) + "\n");
}

// A "raw" filename with one of these extensions is really an earlier export that was
// imported back into Lightroom, not the camera original.
const NON_RAW_PATTERN = /\.(jpe?g|png|webp|heic|tiff?|psd)$/i;

// Strong = traces back to an actual raw file (NEF, DNG, ...).
function isStrongEntry(entry) {
    return Boolean(entry && entry.rawFileName && !NON_RAW_PATTERN.test(entry.rawFileName));
}

// Returns null for a strong entry, otherwise a short description of why the photo would
// be hard to find again.
function describeWeakEntry(entry) {
    if (isStrongEntry(entry)) return null;
    if (entry && entry.rawFileName) return `raw filename ${entry.rawFileName} is an export, not the original`;
    if (entry && entry.captureTime) return "no RawFileName (findable by capture time)";
    return "no Lightroom metadata at all";
}

// Capture time without the UTC offset (exports don't always carry one), split into the
// whole second and the optional fraction.
function splitCaptureTime(value) {
    const match = typeof value === "string" ? value.match(/^([^.Z+]+?(?:T\d{2}:\d{2}:\d{2}))(?:\.(\d+))?/) : null;
    return match ? { second: match[1], fraction: match[2] } : null;
}

function sameCaptureTime(a, b) {
    const left = splitCaptureTime(a);
    const right = splitCaptureTime(b);
    if (!left || !right || left.second !== right.second) return false;
    // Compare sub-seconds only when both sides have them.
    return !left.fraction || !right.fraction || left.fraction === right.fraction;
}

// True when two sets of source metadata describe the same Lightroom photo: the same
// document ID (with capture times that agree, if both have one), or the same capture
// time to the sub-second on the same camera.
function isSamePhoto(a, b) {
    if (a.documentId && b.documentId && a.documentId === b.documentId) {
        return !a.captureTime || !b.captureTime || sameCaptureTime(a.captureTime, b.captureTime);
    }
    return Boolean(
        a.camera &&
            a.camera === b.camera &&
            splitCaptureTime(a.captureTime) &&
            splitCaptureTime(a.captureTime).fraction &&
            splitCaptureTime(b.captureTime) &&
            splitCaptureTime(b.captureTime).fraction &&
            sameCaptureTime(a.captureTime, b.captureTime)
    );
}

// Copies where-it-came-from fields onto an existing entry, keeping its exportedAs (the
// name the site's export had).
function mergeSource(entry, metadata) {
    const merged = { exportedAs: entry.exportedAs, recordedAt: buildLedgerEntry({}, "").recordedAt };
    for (const field of ["rawFileName", "captureTime", "camera", "serial", "lens", "documentId"]) {
        const value = metadata[field] !== undefined ? metadata[field] : entry[field];
        if (value !== undefined) merged[field] = value;
    }
    return merged;
}

// Every ledger key the manifest implies, as a Set.
function manifestKeys(manifest) {
    const keys = new Set();
    for (const [type, folders] of Object.entries(manifest || {})) {
        for (const [folder, entries] of Object.entries(folders || {})) {
            for (const entry of entries || []) {
                keys.add(ledgerKey(type, folder, entry.filename));
            }
        }
    }
    return keys;
}

function findStaleKeys(ledger, manifest) {
    const valid = manifestKeys(manifest);
    return Object.keys(ledger).filter(key => !valid.has(key));
}

// Deletes every ledger entry that has no matching photo in the manifest and returns
// the keys it removed.
function pruneLedger(ledger, manifest) {
    const removed = findStaleKeys(ledger, manifest);
    for (const key of removed) {
        delete ledger[key];
    }
    return removed;
}

// Wraps pruneLedger with the safety checks the scripts share. Returns the keys that
// were removed (or, under dryRun, the keys that would be). Never prunes when the
// manifest wasn't really loaded, has no photos, or the prune would drop more than
// half of the ledger (unless force is set).
function pruneLedgerSafely(ledger, manifest, options) {
    const { manifestLoaded, dryRun, force, tag } = options;
    const prefix = `[${tag}]`;

    if (!manifestLoaded) {
        console.warn(`${prefix} Skipping ledger prune: the manifest was missing, empty, or could not be parsed.`);
        return [];
    }
    if (manifestKeys(manifest).size === 0) {
        console.warn(`${prefix} Skipping ledger prune: the manifest contains no photos.`);
        return [];
    }

    const stale = findStaleKeys(ledger, manifest);
    if (stale.length === 0) {
        return [];
    }

    const ledgerSize = Object.keys(ledger).length;
    if (stale.length > ledgerSize / 2 && !force) {
        console.warn(
            `${prefix} Skipping ledger prune: it would remove ${stale.length} of ${ledgerSize} entries (more than half). ` +
                "If that is really what you want, re-run with --force-prune."
        );
        return [];
    }

    for (const key of stale) {
        console.log(dryRun ? `[dry-run] Would remove ledger entry ${key}` : `[prune] Removed ledger entry ${key}`);
    }
    if (!dryRun) {
        pruneLedger(ledger, manifest);
    }
    return stale;
}

module.exports = {
    LEDGER_PATH,
    MANIFEST_PATH,
    ensureWebpFilename,
    ledgerKey,
    mapSourceMetadata,
    extractSourceMetadata,
    buildLedgerEntry,
    loadLedger,
    saveLedger,
    describeWeakEntry,
    isStrongEntry,
    isSamePhoto,
    mergeSource,
    manifestKeys,
    pruneLedger,
    pruneLedgerSafely
};
