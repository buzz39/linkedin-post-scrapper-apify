const { Actor } = require('apify');
const { CheerioCrawler, ProxyConfiguration } = require('crawlee');

const EMBED_URL = 'https://www.linkedin.com/embed/feed/update';

Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { profileUrl, postUrl, postUrls, count = 10 } = input;

    // Collect all post URLs
    const urls = [];
    if (postUrl) urls.push(postUrl);
    if (Array.isArray(postUrls)) urls.push(...postUrls);

    // ── Mode 1: Scrape individual posts via embed endpoint (no auth needed) ──
    if (urls.length > 0) {
        console.log(`Fetching ${urls.length} post(s) via embed endpoint...`);

        const proxyConfiguration = await Actor.createProxyConfiguration({
            groups: ['RESIDENTIAL'],
            countryCode: 'US',
        });

        const crawler = new CheerioCrawler({
            proxyConfiguration,
            maxConcurrency: 3,
            requestHandlerTimeoutSecs: 30,
            async requestHandler({ request, $, response }) {
                const originalUrl = request.userData.originalUrl;
                const statusCode = response.statusCode;

                if (statusCode !== 200) {
                    console.log(`⚠️ Got ${statusCode} for: ${originalUrl}`);
                    await Actor.pushData({
                        url: originalUrl,
                        success: false,
                        error: `HTTP ${statusCode}`,
                        fetchedAt: new Date().toISOString(),
                    });
                    return;
                }

                // Parse the embed page
                const authorName = $('.author-info__name').text().trim() ||
                                   $('[data-tracking-control-name="public_post_feed-actor-name"]').text().trim();
                const authorHeadline = $('.author-info__subtitle').text().trim();
                const postText = $('.feed-item-main-content').text().trim() ||
                                 $('.attributed-text').text().trim();
                const timestamp = $('time').text().trim() || $('.publish-date').text().trim();
                const likeCount = extractNumber($('.social-counts-reactions__social-counts-numLikes').text());
                const commentCount = extractNumber($('.social-counts-comments').text());
                const repostCount = extractNumber($('.social-counts-reposts').text());

                // Extract images
                const images = [];
                $('img[data-delayed-url], img.update-components-image__image').each((i, el) => {
                    const src = $(el).attr('data-delayed-url') || $(el).attr('src');
                    if (src && !src.includes('profile-photo') && !src.includes('logo')) {
                        images.push(src);
                    }
                });

                // Extract video if present
                const videoUrl = $('video source').attr('src') || null;

                const result = {
                    url: originalUrl,
                    success: true,
                    authorName,
                    authorHeadline,
                    postText,
                    timestamp,
                    likeCount,
                    commentCount,
                    repostCount,
                    images,
                    videoUrl,
                    fetchedAt: new Date().toISOString(),
                };

                console.log(`✅ Fetched: ${authorName} — ${postText.substring(0, 80)}...`);
                await Actor.pushData(result);
            },
            async failedRequestHandler({ request }, error) {
                console.error(`❌ Failed: ${request.userData.originalUrl} — ${error.message}`);
                await Actor.pushData({
                    url: request.userData.originalUrl,
                    success: false,
                    error: error.message,
                    fetchedAt: new Date().toISOString(),
                });
            },
        });

        const requests = urls.map(url => {
            const embedUrl = convertToEmbedUrl(url);
            return {
                url: embedUrl,
                userData: { originalUrl: url },
            };
        });

        await crawler.run(requests);
        return;
    }

    // ── Mode 2: Profile posts via public activity page ──
    let username = profileUrl || input.username;
    if (!username) {
        throw new Error(
            'No input provided. Use one of:\n' +
            '  - "profileUrl": LinkedIn profile URL or username\n' +
            '  - "postUrl": single LinkedIn post URL\n' +
            '  - "postUrls": array of LinkedIn post URLs'
        );
    }

    const match = username.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (match) username = match[1];

    console.log(`Fetching recent posts for profile: ${username}`);

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });

    // Scrape the public activity page
    const activityUrl = `https://www.linkedin.com/in/${username}/recent-activity/all/`;
    const crawler = new CheerioCrawler({
        proxyConfiguration,
        maxConcurrency: 1,
        async requestHandler({ $, response }) {
            if (response.statusCode !== 200) {
                throw new Error(`LinkedIn returned ${response.statusCode}`);
            }

            // LinkedIn renders activity page server-side with post data in script tags
            const scriptTags = $('script[type="application/ld+json"]').toArray();
            let posts = [];

            // Try to extract from LD+JSON
            for (const tag of scriptTags) {
                try {
                    const data = JSON.parse($(tag).html());
                    if (data['@type'] === 'Article' || data['@type'] === 'SocialMediaPosting') {
                        posts.push({
                            url: data.url || activityUrl,
                            authorName: data.author?.name || username,
                            postText: data.articleBody || data.description || '',
                            timestamp: data.datePublished || '',
                            success: true,
                            fetchedAt: new Date().toISOString(),
                        });
                    }
                } catch (e) { /* skip invalid JSON */ }
            }

            // Fallback: parse from HTML
            if (posts.length === 0) {
                // LinkedIn's public page has <li> items with post content
                $('div.feed-shared-update-v2, li.profile-creator-shared-feed-update__container').each((i, el) => {
                    if (i >= count) return false;
                    const $el = $(el);
                    const text = $el.find('.feed-shared-text__text-view, .break-words').text().trim();
                    const postLink = $el.find('a[href*="activity"]').attr('href') || '';
                    const time = $el.find('time').attr('datetime') || $el.find('.feed-shared-actor__sub-description').text().trim();

                    if (text) {
                        posts.push({
                            url: postLink.startsWith('http') ? postLink : `https://www.linkedin.com${postLink}`,
                            authorName: username,
                            postText: text,
                            timestamp: time,
                            success: true,
                            fetchedAt: new Date().toISOString(),
                        });
                    }
                });
            }

            if (posts.length === 0) {
                // Last resort: dump what we can see
                console.log('⚠️ Could not parse posts from page. LinkedIn may require JS rendering.');
                console.log('Page title:', $('title').text());
                await Actor.pushData({
                    error: 'Could not parse posts. Profile may be private or LinkedIn requires browser rendering.',
                    username,
                    suggestion: 'Try using postUrl/postUrls with specific post URLs instead — the embed endpoint is more reliable.',
                    fetchedAt: new Date().toISOString(),
                });
                return;
            }

            console.log(`✅ Found ${posts.length} posts for ${username}`);
            for (const post of posts.slice(0, count)) {
                await Actor.pushData(post);
            }
        },
    });

    await crawler.run([activityUrl]);
});


// ── Helpers ──

function convertToEmbedUrl(url) {
    // Extract activity ID from various LinkedIn URL formats
    let activityId = null;

    // Format: /posts/username_text-activity-1234567890-xxx/
    const activityMatch = url.match(/activity[:-](\d+)/);
    if (activityMatch) {
        activityId = activityMatch[1];
    }

    if (activityId) {
        // Try both share and ugcPost URN formats — share is more common for embed
        return `${EMBED_URL}/urn:li:share:${activityId}`;
    }

    // If we can't parse it, try the URL as-is with embed
    const ugcMatch = url.match(/ugcPost[:-](\d+)/);
    if (ugcMatch) {
        return `${EMBED_URL}/urn:li:ugcPost:${ugcMatch[1]}`;
    }

    // Fallback: return original (will likely fail gracefully)
    return url;
}

function extractNumber(text) {
    if (!text) return 0;
    const cleaned = text.replace(/,/g, '').trim();
    const match = cleaned.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}
