const { DateTime } = require("luxon");

module.exports = function (eleventyConfig) {
  // ✅ Fix timezone issue: add a UTC date filter
  eleventyConfig.addFilter("utcDate", (dateObj, format = "MMMM dd") => {
    // Handles both string and object dates safely
    if (!dateObj) return "";

    // If the date is an object with a .start property, use that
    const isoDate = typeof dateObj === "string" ? dateObj : dateObj.toString();

    return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat(format);
  });

  // Pass through images
  eleventyConfig.addPassthroughCopy("src/content/**/*.jpg");
  eleventyConfig.addPassthroughCopy("src/content/**/*.webp");
  // eleventyConfig.addPassthroughCopy({ "src/assets/favicon": "/" });

  return {
    dir: {
      input: "src",
      output: "_site",
    },
    passthroughFileCopy: true
  };
};