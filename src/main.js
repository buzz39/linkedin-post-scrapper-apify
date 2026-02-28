import { Actor, log } from 'apify';
import { fetchPost, fetchProfilePosts } from './linkedinApiFetcher.js';
import { isLinkedInUrl } from './utils.js';

await Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const { postUrl, postUrls, profileUrl, maxPosts } = input;

  // Validate inputs
  if (!postUrl && (!postUrls || postUrls.length === 0) && !profileUrl) {
    await Actor.fail('Please provide postUrl, postUrls (array), or profileUrl as input.');
    return;
  }

  // Build list of URLs to scrape
  let urlsToProcess = [];

  if (profileUrl) {
    if (!isLinkedInUrl(profileUrl)) {
      await Actor.fail(`Invalid LinkedIn profile URL: ${profileUrl}`);
      return;
    }
    try {
      urlsToProcess = await fetchProfilePosts(profileUrl, maxPosts || 10, {});
      if (urlsToProcess.length === 0) {
        log.warning('No posts found on profile activity page');
      }
    } catch (e) {
      log.error(`Profile scraping failed: ${e.message}`);
      await Actor.fail(`Could not fetch profile posts: ${e.message}`);
      return;
    }
  } else {
    urlsToProcess = postUrls || [postUrl];
  }

  // Validate all URLs
  urlsToProcess = urlsToProcess.filter((u) => {
    if (!isLinkedInUrl(u)) {
      log.warning(`Skipping invalid LinkedIn URL: ${u}`);
      return false;
    }
    return true;
  });

  if (urlsToProcess.length === 0) {
    await Actor.fail('No valid LinkedIn URLs to process.');
    return;
  }

  log.info(`Processing ${urlsToProcess.length} post(s)...`);

  const rateLimit = parseInt(process.env.LINKEDIN_RATE_LIMIT || '1500', 10);

  for (let i = 0; i < urlsToProcess.length; i++) {
    const url = urlsToProcess[i];

    try {
      log.info(`[${i + 1}/${urlsToProcess.length}] ${url}`);
      const postData = await fetchPost(url, {});

      await Actor.pushData(postData);
    } catch (error) {
      log.error(`Failed: ${url} — ${error.message}`);
      await Actor.pushData({
        postUrl: url,
        error: error.message,
        success: false,
        fetchedAt: new Date().toISOString(),
      });
    }

    // Rate limiting between requests
    if (i < urlsToProcess.length - 1) {
      await new Promise((r) => setTimeout(r, rateLimit + Math.random() * 1000));
    }
  }

  log.info('Done!');
});
