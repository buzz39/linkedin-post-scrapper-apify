const { Actor } = require('apify');
const { gotScraping } = require('got-scraping');

const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api';

const HEADERS = {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'accept-language': 'en-US,en;q=0.9',
    'x-li-lang': 'en_US',
    'x-restli-protocol-version': '2.0.0',
    'x-li-track': JSON.stringify({
        clientVersion: '1.13.8677',
        mpVersion: '1.13.8677',
        osName: 'web',
        timezoneOffset: -5,
        timezone: 'America/New_York',
        deviceFormFactor: 'DESKTOP',
        mpName: 'voyager-web',
        displayDensity: 1,
        displayWidth: 1920,
        displayHeight: 1080,
    }),
};

/**
 * Extract activity ID from various LinkedIn post URL formats
 */
function extractActivityId(url) {
    // /posts/username_text-activity-1234567890-xxxx
    let match = url.match(/activity[- ](\d+)/i);
    if (match) return match[1];

    // /feed/update/urn:li:activity:1234567890
    match = url.match(/urn:li:activity:(\d+)/);
    if (match) return match[1];

    // /feed/update/urn:li:ugcPost:1234567890
    match = url.match(/urn:li:ugcPost:(\d+)/);
    if (match) return match[1];

    return null;
}

/**
 * Make authenticated Voyager API request
 */
async function voyagerGet(path, { li_at, jsessionid, proxyUrl }) {
    const csrfToken = jsessionid || `ajax:${Date.now()}`;
    const cookieStr = `li_at=${li_at}; JSESSIONID="${csrfToken}"`;

    const response = await gotScraping({
        url: `${VOYAGER_BASE}${path}`,
        headers: {
            ...HEADERS,
            'csrf-token': csrfToken,
            'cookie': cookieStr,
        },
        proxyUrl,
        responseType: 'json',
        timeout: { request: 30000 },
    });

    return response.body;
}

/**
 * Parse a feed update from Voyager API response
 */
function parseUpdate(element, included = []) {
    // Build lookup map from included entities
    const entityMap = {};
    for (const item of included) {
        if (item.entityUrn || item['*entityUrn']) {
            entityMap[item.entityUrn || item['*entityUrn']] = item;
        }
        if (item.$recipeTypes) {
            // Index by recipe type for easier lookup
            for (const type of item.$recipeTypes) {
                if (!entityMap[type]) entityMap[type] = [];
                entityMap[type].push(item);
            }
        }
    }

    const result = {
        success: false,
        authorName: '',
        authorHeadline: '',
        authorProfileUrl: '',
        authorProfileId: '',
        postText: '',
        timestamp: '',
        postedAtTimestamp: null,
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        images: [],
        videoUrl: null,
        articleTitle: '',
        articleLink: '',
        hashtags: [],
        urn: '',
        url: '',
        isRepost: false,
        type: 'text',
    };

    // Find the actual content - navigate through the complex response structure
    // Look for activity/ugcPost in included items
    let postData = null;
    let actorData = null;
    let socialDetail = null;
    let commentary = null;

    for (const item of included) {
        const urn = item.entityUrn || '';

        // Find the post content (ugcPost or share)
        if (urn.includes('urn:li:ugcPost:') || urn.includes('urn:li:share:')) {
            if (item.commentary || item.text || item.specificContent) {
                postData = item;
            }
        }

        // Find actor (author info)
        if (item.$type === 'com.linkedin.voyager.feed.render.ActorComponent' ||
            urn.includes('urn:li:fsd_profile:') || urn.includes('urn:li:fs_miniProfile:')) {
            if (item.firstName || item.name || item.title) {
                actorData = item;
            }
        }

        // Find social counts
        if (item.$type === 'com.linkedin.voyager.feed.render.SocialDetail' ||
            item.totalSocialActivityCounts || item.likes || item.numLikes !== undefined) {
            socialDetail = item;
        }
    }

    // Extract text from various possible locations
    if (postData) {
        // Commentary text (newer format)
        if (postData.commentary && postData.commentary.text) {
            result.postText = postData.commentary.text.text || postData.commentary.text;
        }
        // Direct text
        else if (postData.text && typeof postData.text === 'object') {
            result.postText = postData.text.text || '';
        }
        else if (typeof postData.text === 'string') {
            result.postText = postData.text;
        }
        // specificContent (older format)
        else if (postData.specificContent) {
            const shareCommentary = postData.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary;
            if (shareCommentary) {
                result.postText = shareCommentary.text || '';
            }
        }

        // Timestamp
        if (postData.createdAt || postData.created) {
            result.postedAtTimestamp = postData.createdAt || postData.created?.time;
            if (result.postedAtTimestamp) {
                result.timestamp = new Date(result.postedAtTimestamp).toISOString();
            }
        }

        // URN
        result.urn = postData.entityUrn || '';
    }

    // Extract author from included miniProfiles
    for (const item of included) {
        if (item.$type?.includes('miniProfile') || item.$type?.includes('MiniProfile') ||
            (item.firstName && item.lastName && item.publicIdentifier)) {
            result.authorName = `${item.firstName || ''} ${item.lastName || ''}`.trim();
            result.authorHeadline = item.occupation || item.headline || '';
            result.authorProfileId = item.publicIdentifier || '';
            result.authorProfileUrl = item.publicIdentifier
                ? `https://www.linkedin.com/in/${item.publicIdentifier}`
                : '';
            break;
        }
    }

    // Extract social counts
    if (socialDetail) {
        const counts = socialDetail.totalSocialActivityCounts || socialDetail;
        result.likeCount = counts.numLikes || counts.likes || 0;
        result.commentCount = counts.numComments || counts.comments || 0;
        result.shareCount = counts.numShares || counts.shares || 0;
    }

    // Look for social counts in all included items
    for (const item of included) {
        if (item.numLikes !== undefined && !socialDetail) {
            result.likeCount = item.numLikes || 0;
            result.commentCount = item.numComments || 0;
            result.shareCount = item.numShares || 0;
        }
        // Also check socialDetail references
        if (item.$type === 'com.linkedin.voyager.feed.shared.SocialDetail') {
            result.likeCount = item.totalSocialActivityCounts?.numLikes || result.likeCount;
            result.commentCount = item.totalSocialActivityCounts?.numComments || result.commentCount;
            result.shareCount = item.totalSocialActivityCounts?.numShares || result.shareCount;
        }
    }

    // Extract images from included items
    for (const item of included) {
        if (item.$type?.includes('Image') || item.$type?.includes('image')) {
            const artifacts = item.data?.['com.linkedin.digitalmedia.mediaartifact.StillImage']?.storageAspect?.cropped?.artifacts;
            if (artifacts) {
                const largest = artifacts[artifacts.length - 1];
                if (largest?.fileIdentifyingUrlPathSegment) {
                    result.images.push(`https://media.licdn.com/dms/image/${largest.fileIdentifyingUrlPathSegment}`);
                }
            }
        }
        // Vectorized images (newer format)
        if (item.rootUrl && item.artifacts) {
            const largest = item.artifacts[item.artifacts.length - 1];
            if (largest?.fileIdentifyingUrlPathSegment) {
                result.images.push(`${item.rootUrl}${largest.fileIdentifyingUrlPathSegment}`);
            }
        }
    }

    // Extract video
    for (const item of included) {
        if (item.$type?.includes('Video') || item.progressiveStreams) {
            if (item.progressiveStreams?.length > 0) {
                result.videoUrl = item.progressiveStreams[0].streamingLocations?.[0]?.url || null;
                result.type = 'video';
            }
        }
    }

    // Extract article
    for (const item of included) {
        if (item.$type?.includes('Article') || item.$type?.includes('ExternalUrl')) {
            result.articleTitle = item.title?.text || item.title || '';
            result.articleLink = item.url || item.navigationUrl || '';
            if (result.articleTitle) result.type = 'article';
        }
    }

    // Extract hashtags from text
    if (result.postText) {
        const hashtagMatches = result.postText.match(/#[\w]+/g);
        if (hashtagMatches) {
            result.hashtags = hashtagMatches;
        }
    }

    // Determine type
    if (result.images.length > 0 && result.type === 'text') result.type = 'image';

    result.success = !!(result.postText || result.authorName);

    return result;
}


Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { profileUrl, postUrl, postUrls, count = 10, li_at, jsessionid } = input;

    if (!li_at) {
        throw new Error('li_at cookie is required. Get it from DevTools → Application → Cookies → linkedin.com → li_at');
    }

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });
    const proxyUrl = await proxyConfiguration.newUrl();

    const authOpts = { li_at, jsessionid, proxyUrl };

    // ── Verify session first ──
    console.log('🔐 Verifying LinkedIn session...');
    try {
        const me = await voyagerGet('/me', authOpts);
        const name = me?.miniProfile
            ? `${me.miniProfile.firstName} ${me.miniProfile.lastName}`
            : 'Unknown';
        console.log(`✅ Authenticated as: ${name}`);
    } catch (e) {
        console.error('❌ Authentication failed:', e.message);
        throw new Error('li_at cookie is invalid or expired. Get a fresh one from your browser.');
    }

    // ── Collect URLs ──
    const urls = [];
    if (postUrl) urls.push(postUrl);
    if (Array.isArray(postUrls)) urls.push(...postUrls);

    // ── Mode 1: Individual posts ──
    if (urls.length > 0) {
        console.log(`📝 Fetching ${urls.length} post(s) via Voyager API...`);

        for (const url of urls) {
            const activityId = extractActivityId(url);
            if (!activityId) {
                console.error(`⚠️ Could not extract activity ID from: ${url}`);
                await Actor.pushData({
                    url,
                    success: false,
                    error: 'Could not extract activity ID from URL',
                    fetchedAt: new Date().toISOString(),
                });
                continue;
            }

            console.log(`  Fetching activity: ${activityId}`);

            try {
                // Try the feed update endpoint
                const urn = `urn:li:activity:${activityId}`;
                const encodedUrn = encodeURIComponent(urn);
                
                // Use the feed updates endpoint with the activity URN
                const data = await voyagerGet(
                    `/feed/updates?ids=List(${encodedUrn})`,
                    authOpts
                );

                const included = data?.included || [];
                const elements = data?.elements || (data?.results ? Object.values(data.results) : []);

                if (included.length === 0 && elements.length === 0) {
                    // Try alternative endpoint
                    console.log('  Trying alternative endpoint...');
                    const data2 = await voyagerGet(
                        `/feed/updates/${encodedUrn}`,
                        authOpts
                    );
                    
                    const included2 = data2?.included || [];
                    const result = parseUpdate(data2, included2);
                    result.url = url;
                    result.fetchedAt = new Date().toISOString();
                    
                    if (!result.success) {
                        // Try ugcPost format
                        console.log('  Trying ugcPost endpoint...');
                        const data3 = await voyagerGet(
                            `/feed/updates/urn:li:ugcPost:${activityId}`,
                            authOpts
                        );
                        const result3 = parseUpdate(data3, data3?.included || []);
                        result3.url = url;
                        result3.fetchedAt = new Date().toISOString();
                        await Actor.pushData(result3);
                    } else {
                        await Actor.pushData(result);
                    }
                    continue;
                }

                const result = parseUpdate(elements[0] || {}, included);
                result.url = url;
                result.urn = result.urn || urn;
                result.fetchedAt = new Date().toISOString();

                if (result.success) {
                    console.log(`  ✅ ${result.authorName}: ${result.postText.substring(0, 80)}...`);
                } else {
                    console.log(`  ⚠️ Parsed but no content extracted. Keys: ${Object.keys(data).join(', ')}`);
                    // Store raw response for debugging
                    await Actor.setValue(`debug-raw-${activityId}.json`, data, { contentType: 'application/json' });
                    result.error = 'Could not parse post content from API response';
                    result._rawKeys = Object.keys(data);
                    result._includedTypes = [...new Set(included.map(i => i.$type).filter(Boolean))];
                    result._includedCount = included.length;
                }

                await Actor.pushData(result);
            } catch (e) {
                console.error(`  ❌ Failed: ${e.message}`);
                await Actor.pushData({
                    url,
                    success: false,
                    error: e.message,
                    fetchedAt: new Date().toISOString(),
                });
            }

            // Rate limiting - small delay between requests
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
        }
        return;
    }

    // ── Mode 2: Profile posts ──
    let username = profileUrl || input.username;
    if (!username) throw new Error('Provide postUrl, postUrls, or profileUrl');

    const match = username.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (match) username = match[1];

    console.log(`👤 Fetching ${count} posts for profile: ${username}`);

    try {
        // First get profile URN
        const profileData = await voyagerGet(
            `/identity/profiles/${username}/profileView`,
            authOpts
        );

        const miniProfile = profileData?.included?.find(i =>
            i.$type?.includes('miniProfile') || i.$type?.includes('MiniProfile') ||
            (i.publicIdentifier === username)
        );

        if (!miniProfile) {
            throw new Error(`Profile not found: ${username}`);
        }

        const profileUrn = miniProfile.entityUrn?.replace('fs_miniProfile', 'fsd_profile') ||
            `urn:li:fsd_profile:${miniProfile.objectUrn?.split(':').pop()}`;

        console.log(`  Profile URN: ${profileUrn}`);

        // Fetch posts
        const postsData = await voyagerGet(
            `/identity/profileUpdatesV2?` + new URLSearchParams({
                q: 'memberShareFeed',
                moduleKey: 'member-shares:phone',
                count: String(Math.min(count, 100)),
                start: '0',
                profileUrn,
                includeLongTermHistory: 'true',
            }).toString(),
            authOpts
        );

        const included = postsData?.included || [];
        const elements = postsData?.elements || [];

        console.log(`  Found ${elements.length} feed elements, ${included.length} included items`);

        // Parse each post
        let parsed = 0;
        for (const element of elements) {
            if (parsed >= count) break;

            const result = parseUpdate(element, included);
            if (result.success) {
                result.authorUsername = username;
                result.fetchedAt = new Date().toISOString();
                await Actor.pushData(result);
                parsed++;
                console.log(`  ✅ [${parsed}/${count}] ${result.postText.substring(0, 60)}...`);
            }
        }

        if (parsed === 0) {
            await Actor.setValue('debug-profile-raw.json', postsData, { contentType: 'application/json' });
            await Actor.pushData({
                error: `No posts found for ${username}. Check debug-profile-raw.json`,
                username,
                fetchedAt: new Date().toISOString(),
            });
        } else {
            console.log(`\n✅ Successfully scraped ${parsed} posts for ${username}`);
        }
    } catch (e) {
        console.error(`❌ Failed: ${e.message}`);
        await Actor.pushData({
            error: e.message,
            username,
            fetchedAt: new Date().toISOString(),
        });
    }
});
