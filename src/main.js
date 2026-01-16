import { Actor, log } from 'apify';
import { fetchLinkedInViaAPI } from './linkedinApiFetcher.js';

await Actor.main(async () => {
  try {
    // 1. GET INPUT
    const input = await Actor.getInput() || {};
    const { postUrl, postUrls } = input;

    if (!postUrl && (!postUrls || postUrls.length === 0)) {
      await Actor.fail('Please provide either postUrl or postUrls array');
    }

    const urlsToProcess = postUrls || [postUrl];
    const rateLimit = parseInt(process.env.LINKEDIN_RATE_LIMIT || '1000');

    // 2. PROCESS EACH URL
    for (let i = 0; i < urlsToProcess.length; i++) {
      const url = urlsToProcess[i];

      try {
        log.info(`Processing [${i + 1}/${urlsToProcess.length}]: ${url}`);

        const postData = await fetchLinkedInViaAPI(url);

        await Actor.pushData({
          url,
          success: true,
          data: postData,
          fetchedAt: new Date().toISOString(),
        });

        // 3. RATE LIMITING
        if (i < urlsToProcess.length - 1) {
          await new Promise(resolve =>
            setTimeout(resolve, rateLimit + Math.random() * 500)
          );
        }

      } catch (error) {
        log.error(`Failed to process ${url}: ${error.message}`);

        await Actor.pushData({
          url,
          success: false,
          error: error.message,
          fetchedAt: new Date().toISOString(),
        });
      }
    }

  } catch (error) {
    log.error(`Fatal error: ${error.message}`);
    await Actor.fail(error.message);
  }
});
