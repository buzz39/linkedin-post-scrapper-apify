import * as cheerio from 'cheerio';

/**
 * Parse LinkedIn embed page HTML to extract post data
 */
export function parseEmbedHtml(html, originalUrl) {
  const $ = cheerio.load(html);

  // Post text — the embed page uses a specific structure
  const postText = extractPostText($);
  const authorName = $('.feed-shared-actor__name, .update-components-actor__name, .attributed-text-segment-list__container')
    .first().text().trim()
    || $('h3.base-main-card__title, .profile-card-one-to-one__actor-info h3').first().text().trim()
    || $('[data-tracking-control-name="public_post_feed-actor-name"]').first().text().trim();

  const authorTitle = $('.feed-shared-actor__description, .update-components-actor__description')
    .first().text().trim()
    || $('h4.base-main-card__subtitle').first().text().trim();

  const authorProfileUrl = $('a.feed-shared-actor__container-link, a.update-components-actor__container-link')
    .first().attr('href')
    || $('a[data-tracking-control-name="public_post_feed-actor-name"]').first().attr('href');

  // Engagement counts
  const likesCount = extractCount($, '.social-details-social-counts__reactions-count, .social-counts-reactions__count');
  const commentsCount = extractCount($, '.social-details-social-counts__comments, .social-counts-comments__count');

  // Media
  const media = [];
  $('img.feed-shared-image__image, img.update-components-image__image, .feed-shared-image img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-delayed-url');
    if (src && !src.includes('profile-photo') && !src.includes('actor-image')) {
      media.push({ type: 'image', url: src });
    }
  });
  $('video source, video').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-sources');
    if (src) media.push({ type: 'video', url: src });
  });

  // Hashtags from post text
  const hashtags = [];
  if (postText) {
    const hashtagMatches = postText.match(/#[\w\u00C0-\u024F]+/g);
    if (hashtagMatches) hashtags.push(...new Set(hashtagMatches));
  }

  // Date
  const postedAt = $('time').first().attr('datetime')
    || $('span.feed-shared-actor__sub-description, .update-components-actor__sub-description').first().text().trim()
    || null;

  return {
    postUrl: originalUrl,
    postText: postText || null,
    authorName: authorName || null,
    authorTitle: authorTitle || null,
    authorProfileUrl: normalizeProfileUrl(authorProfileUrl),
    likesCount,
    commentsCount,
    sharesCount: 0,
    postedAt: postedAt || null,
    hashtags,
    media,
  };
}

/**
 * Parse public LinkedIn post page HTML (fallback — JSON-LD + og tags)
 */
export function parsePublicPageHtml(html, originalUrl) {
  const $ = cheerio.load(html);

  // Try JSON-LD first
  let structured = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data['@type'] === 'Article' || data['@type'] === 'SocialMediaPosting' || data.articleBody) {
        structured = data;
      }
    } catch { /* ignore */ }
  });

  if (structured) {
    return {
      postUrl: originalUrl,
      postText: structured.articleBody || structured.description || null,
      authorName: structured.author?.name || null,
      authorTitle: null,
      authorProfileUrl: structured.author?.url || null,
      likesCount: structured.interactionStatistic?.find?.(s => s.interactionType?.includes?.('Like'))?.userInteractionCount || 0,
      commentsCount: structured.interactionStatistic?.find?.(s => s.interactionType?.includes?.('Comment'))?.userInteractionCount || 0,
      sharesCount: 0,
      postedAt: structured.datePublished || structured.dateCreated || null,
      hashtags: extractHashtags(structured.articleBody || structured.description || ''),
      media: structured.image ? [{ type: 'image', url: typeof structured.image === 'string' ? structured.image : structured.image.url }] : [],
    };
  }

  // Fallback: og tags (last resort)
  const description = $('meta[property="og:description"]').attr('content') || '';
  const title = $('meta[property="og:title"]').attr('content') || '';
  const image = $('meta[property="og:image"]').attr('content');

  // If title is garbage like "Sign Up | LinkedIn", the scrape failed
  if (!description || title.includes('Sign Up') || title.includes('Log In')) {
    return null; // Signal failure
  }

  return {
    postUrl: originalUrl,
    postText: description,
    authorName: title.replace(/ on LinkedIn:.*/, '').replace(/ posted on LinkedIn.*/, '').trim() || null,
    authorTitle: null,
    authorProfileUrl: null,
    likesCount: 0,
    commentsCount: 0,
    sharesCount: 0,
    postedAt: null,
    hashtags: extractHashtags(description),
    media: image ? [{ type: 'image', url: image }] : [],
  };
}

// --- Helpers ---

function extractPostText($) {
  // Try multiple selectors used in embed pages
  const selectors = [
    '.feed-shared-update-v2__description .feed-shared-text__text-view',
    '.feed-shared-text__text-view',
    '.update-components-text__text-view',
    '.attributed-text-segment-list__content',
    '.feed-shared-update-v2__commentary .break-words',
    '.break-words .visually-hidden',
    '.feed-shared-inline-show-more-text',
  ];
  for (const sel of selectors) {
    const text = $(sel).first().text().trim();
    if (text && text.length > 10) return text;
  }
  // Last resort: get main content area text
  const bodyText = $('body').text().trim();
  // Try to extract meaningful text between known markers
  return null;
}

function extractCount($, selector) {
  const text = $(selector).first().text().trim();
  if (!text) return 0;
  const num = text.replace(/,/g, '').match(/[\d,]+/);
  return num ? parseInt(num[0].replace(/,/g, ''), 10) : 0;
}

function extractHashtags(text) {
  if (!text) return [];
  const matches = text.match(/#[\w\u00C0-\u024F]+/g);
  return matches ? [...new Set(matches)] : [];
}

function normalizeProfileUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url.split('?')[0];
  if (url.startsWith('/')) return `https://www.linkedin.com${url.split('?')[0]}`;
  return url;
}
