const fs = require("fs");
const path = require("path");

const galleriesPath = path.join(__dirname, "..", "content"); // adjust if you want portfolio too
const previewSuffix = "_preview";

function isPreview(file) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    return base.endsWith(previewSuffix);
}

function clearPreviews(folder) {
    const files = fs.readdirSync(folder);

    for (let file of files) {
        const fullPath = path.join(folder, file);
        if (fs.lstatSync(fullPath).isDirectory()) {
            clearPreviews(fullPath);
        } else if (isPreview(file)) {
            console.log(`Deleting preview: ${fullPath}`);
            fs.unlinkSync(fullPath);
        }
    }
}

function main() {
    if (!fs.existsSync(galleriesPath)) {
        console.error("Path not found:", galleriesPath);
        process.exit(1);
    }
    clearPreviews(galleriesPath);
    console.log("All previews cleared.");
}

main();
