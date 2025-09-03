const fs = require("fs");
const path = require("path");
const { imageSize } = require("image-size");

function getImageFiles(folderPath) {
    return fs.readdirSync(folderPath).filter(file => /\.(jpg|jpeg|png)$/i.test(file));
}

function readGlobalMeta() {
    const metaPath = path.join("src/content", "meta.json");
    if (fs.existsSync(metaPath)) {
        return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    }
    return { portfolio: [], events: [] };
}

function getImageMeta(filePath, publicPath) {
    const buffer = fs.readFileSync(filePath);
    const { width, height, type } = imageSize(buffer);
    return {
        url: publicPath,
        width,
        height,
        type
    };
}

function getGalleries() {
    const baseDir = "src/content";
    const meta = readGlobalMeta();
    let galleries = [];

    // portfolio
    meta.portfolio
        .filter(entry => entry.visible !== false) // default true
        .forEach(entry => {
            const folderPath = path.join(baseDir, "portfolio", entry.folder);
            if (fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory()) {
                const images = getImageFiles(folderPath);
                galleries.push({
                    type: "portfolio",
                    path: `/${entry.folder}/`,
                    images: images.map(file =>
                        getImageMeta(
                            path.join(folderPath, file),
                            `/content/portfolio/${entry.folder}/${file}`
                        )
                    ),
                    title: entry.title,
                    description: entry.description || "",
                    preview: entry.preview
                        ? `/content/portfolio/${entry.folder}/${entry.preview}`
                        : (images.length > 0
                            ? `/content/portfolio/${entry.folder}/${images[0]}`
                            : null)
                });
            }
        });

    // events
    meta.events
        .filter(entry => entry.visible !== false) // default true
        .forEach(entry => {
            const folderPath = path.join(baseDir, "events", entry.folder);
            if (fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory()) {
                const images = getImageFiles(folderPath);
                galleries.push({
                    type: "events",
                    path: `/${entry.folder}/`,
                    images: images.map(file =>
                        getImageMeta(
                            path.join(folderPath, file),
                            `/content/events/${entry.folder}/${file}`
                        )
                    ),
                    title: entry.title,
                    short_title: entry.short_title || entry.title,
                    description: entry.description || "",
                    location: entry.location || "",
                    date: entry.date || null,
                    preview: entry.preview
                        ? `/content/events/${entry.folder}/${entry.preview}`
                        : (images.length > 0
                            ? `/content/events/${entry.folder}/${images[0]}`
                            : null)
                });
            }
        });

    return galleries;
}



// Group events by year-month
function groupEventsByMonth(galleries) {
    const events = galleries.filter(g => g.type === "events");
    const grouped = {};

    events.forEach(event => {
        // Use start date if available, otherwise use single date
        const eventDate = event.date.start ? new Date(event.date.start) : new Date(event.date);

        // Use middle of the month to avoid timezone rollover issues
        const key = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, "0")}-15`;

        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(event);
    });

    // Convert to array format sorted by month descending
    return Object.entries(grouped)
        .map(([month, items]) => ({ month, items }))
        .sort((a, b) => (a.month < b.month ? 1 : -1));
}

const galleries = getGalleries();
console.log(galleries)
const eventsByMonth = groupEventsByMonth(galleries);

module.exports = {
    galleries,
    eventsByMonth
};
