const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE = /(?<![\d$])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g;
const SUFFIX =
  "(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl)";
const ADDRESS = new RegExp(
  `\\b\\d{1,6}\\s+(?:[A-Z][A-Za-z.'-]*\\s+){0,4}${SUFFIX}\\b\\.?(?:,?\\s*(?:Unit|Apt|Apartment|Suite|Ste|#)\\s*[A-Za-z0-9-]+)?`,
  "g",
);

/** Strips emails, North American phone numbers and US street addresses. */
export function redactContacts(text: string): string {
  return text
    .replace(EMAIL, "[email removed]")
    .replace(PHONE, "[phone removed]")
    .replace(ADDRESS, "[address removed]");
}
