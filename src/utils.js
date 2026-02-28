/**
 * URL parsing utilities for LinkedIn post URLs
 */

/**
 * Extract activity/share/ugcPost URN ID from various LinkedIn URL formats
 * Returns { type, id } or null
 */
export function extractUrnFromUrl(url) {
  if (!url || typeof url !== 'string') return null;

  // Format: /feed/update/urn:li:activity:1234567890
  let match = url.match(/urn:li:(activity|share|ugcPost):(\d+)/);
  if (match) return { type: match[1], id: match[2] };

  // Format: /posts/username_slug-activity-1234567890-xxxx
  match = url.match(/\/posts\/[^/]+-activity-(\d+)/);
  if (match) return { type: 'activity', id: match[1] };

  // Format: /pulse/ articles — not supported
  return null;
}

/**
 * Extract username from LinkedIn profile URL
 */
export function extractUsername(url) {
  const match = url?.match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

/**
 * Validate that a string looks like a LinkedIn URL
 */
export function isLinkedInUrl(url) {
  return typeof url === 'string' && /linkedin\.com\//i.test(url);
}

/**
 * Build embed URL for a given URN
 */
export function buildEmbedUrl(urnType, urnId) {
  return `https://www.linkedin.com/embed/feed/update/urn:li:${urnType}:${urnId}`;
}
