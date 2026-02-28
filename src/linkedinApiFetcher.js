import axios from 'axios';
import { Actor, log } from 'apify';
import { createEmbedHeaders, createBrowserHeaders } from './headers.js';
import { parseEmbedHtml, parsePublicPageHtml } from './parser.js';
import { extractUrnFromUrl, buildEmbedUrl, extractUsername, isLinkedInUrl } from './utils.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 3;

/**
 * Create axios instance with Apify residential proxy
 */
async function createAxiosWithProxy() {
  let proxyUrl = null;
  try {
    const proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] });
    proxyUrl = await proxyConfiguration.newUrl();
  } catch (e) {
    log.warning(`Proxy setup failed (running locally?): ${e.message}`);
  }

  const config = { timeout: 20000 };
  if (proxyUrl) {
    config.proxy = false; // disable default proxy
    config.httpsAgent = (await import('https')).default.Agent && undefined; // placeholder
    // Use proxy URL directly via env or axios proxy config
    const parsed = new URL(proxyUrl);
    config.proxy = {
      protocol: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: parseInt(parsed.port, 10),
      auth: parsed.username ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) } : undefined,
    };
  }
  return config;
}

/**
 * Fetch a single LinkedIn post — tries embed endpoint first, then public page
 */
export async function fetchPost(url, axiosConfig) {
  const urn = extractUrnFromUrl(url);
  if (!urn) {
    throw new Error(`Could not extract activity/share URN from URL: ${url}`);
  }

  // Try multiple URN types for embed endpoint
  const urnTypesToTry = [urn.type];
  if (urn.type === 'activity') {
    urnTypesToTry.push('ugcPost', 'share');
  } else if (urn.type === 'share') {
    urnTypesToTry.push('activity', 'ugcPost');
  }

  // Primary: embed endpoint
  for (const urnType of urnTypesToTry) {
    const embedUrl = buildEmbedUrl(urnType, urn.id);
    log.debug(`Trying embed: ${embedUrl}`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await axios.get(embedUrl, {
          ...axiosConfig,
          headers: createEmbedHeaders(),
          validateStatus: (s) => s < 500,
        });

        if (resp.status === 200 && resp.data && !resp.data.includes('Page not found')) {
          const result = parseEmbedHtml(resp.data, url);
          if (result && (result.postText || result.authorName)) {
            log.info(`✓ Embed succeeded for ${url}`);
            return result;
          }
        }

        if (resp.status === 429) {
          await sleep(2 ** attempt * 2000);
          continue;
        }
        break; // non-retryable status
      } catch (e) {
        if (attempt < MAX_RETRIES) await sleep(2 ** attempt * 1000);
      }
    }
  }

  // Fallback: public page HTML
  log.info(`Embed failed, trying public page for ${url}`);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(url, {
        ...axiosConfig,
        headers: createBrowserHeaders(),
        validateStatus: (s) => s < 500,
        maxRedirects: 5,
      });

      if (resp.status === 200) {
        const result = parsePublicPageHtml(resp.data, url);
        if (result) {
          log.info(`✓ Public page fallback succeeded for ${url}`);
          return result;
        }
      }

      if (resp.status === 429 && attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 2000);
        continue;
      }
      if (resp.status === 404) throw new Error(`Post not found (404): ${url}`);
    } catch (e) {
      if (e.message.includes('404')) throw e;
      if (attempt < MAX_RETRIES) await sleep(2 ** attempt * 1000);
      else throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES} attempts: ${e.message}`);
    }
  }

  throw new Error(`Could not extract post data from ${url} — all methods failed`);
}

/**
 * Discover recent post URLs from a profile's activity page
 */
export async function fetchProfilePosts(profileUrl, maxPosts, axiosConfig) {
  const username = extractUsername(profileUrl);
  if (!username) throw new Error(`Could not extract username from: ${profileUrl}`);

  const activityUrl = `https://www.linkedin.com/in/${username}/recent-activity/all/`;
  log.info(`Fetching profile activity: ${activityUrl}`);

  const resp = await axios.get(activityUrl, {
    ...axiosConfig,
    headers: createBrowserHeaders(),
    validateStatus: (s) => s < 500,
    maxRedirects: 5,
  });

  if (resp.status !== 200) {
    throw new Error(`Failed to load profile activity (${resp.status}): ${activityUrl}`);
  }

  // Extract post URLs from activity page HTML
  const postUrls = [];
  const urnPattern = /urn:li:(activity|share|ugcPost):(\d+)/g;
  let match;
  const seen = new Set();
  while ((match = urnPattern.exec(resp.data)) !== null) {
    const key = match[2];
    if (!seen.has(key)) {
      seen.add(key);
      postUrls.push(`https://www.linkedin.com/feed/update/urn:li:${match[1]}:${match[2]}`);
    }
    if (postUrls.length >= (maxPosts || 10)) break;
  }

  log.info(`Found ${postUrls.length} posts from profile ${username}`);
  return postUrls;
}
