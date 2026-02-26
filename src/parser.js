import * as cheerio from 'cheerio';

/**
 * Parses LinkedIn HTML and extracts post/profile data
 */
export function parseLinkedInHTML(html) {
  const $ = cheerio.load(html);

  // Extract OpenGraph meta tags (most reliable)
  const postData = {
    title: $('meta[property="og:title"]').attr('content'),
    description: $('meta[property="og:description"]').attr('content'),
    image: $('meta[property="og:image"]').attr('content'),
    url: $('meta[property="og:url"]').attr('content'),
    type: $('meta[property="og:type"]').attr('content'),
  };

  // Fallback to parsing structured data
  if (!postData.title) {
    postData.title = $('h1').first().text().trim();
  }

  // Extract structured data (JSON-LD)
  const structuredData = $('script[type="application/ld+json"]').first().html();
  if (structuredData) {
    try {
      postData.structured = JSON.parse(structuredData);
    } catch {
      // JSON parsing failed, continue without it
    }
  }

  return postData;
}
