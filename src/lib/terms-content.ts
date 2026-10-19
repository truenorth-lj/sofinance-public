/** Shared Terms of Service content (used by the /terms page and its tests). */
export const TERMS_LAST_UPDATED = "October 19, 2026";

/** Keep identical to the restricted-region list enforced by the app (src/lib/restricted-regions.ts). */
export const TERMS_RESTRICTED_REGIONS = [
  "Taiwan",
  "the United States and its territories (Puerto Rico, Guam, the U.S. Virgin Islands, American Samoa, the Northern Mariana Islands and the U.S. Minor Outlying Islands)",
  "Cuba",
  "Iran",
  "North Korea",
  "Syria",
  "the Crimea, Sevastopol, Donetsk and Luhansk regions of Ukraine",
] as const;
