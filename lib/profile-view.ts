import { getCorpus } from "./corpus-cache";
import type { Profile } from "./corpus";
import { logServerError } from "./log";
import { photoVersion } from "./photo-version";

/** The profile plus a cache-busting photo URL, or null when the corpus failed to load (details logged server-side). */
export async function loadProfileView(): Promise<{ profile: Profile; photoUrl?: string } | null> {
  // Corpus is cached after the first successful load; restart to pick up edits.
  let profile;
  let photoPath;
  try {
    ({ profile, photoPath } = await getCorpus());
  } catch (err) {
    // Log details server-side only; nothing from err reaches the page.
    // stderr, not console: React replays server console calls (with paths) into the browser in dev.
    logServerError("Failed to load corpus", err);
    return null;
  }
  let photoUrl: string | undefined;
  if (photoPath) {
    try {
      // Version token busts the browser cache when the photo file changes (the route ignores it).
      photoUrl = `/api/photo?v=${await photoVersion(photoPath)}`;
    } catch (err) {
      // A photo-only failure must not take down the page; fall back to initials.
      logServerError("Failed to version photo", err);
    }
  }
  return { profile, photoUrl };
}
