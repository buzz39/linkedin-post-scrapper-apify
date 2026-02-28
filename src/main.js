const { Actor } = require('apify');
const axios = require('axios').default;

const API_URL = 'http://161.153.64.255:8000';

Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { profileUrl, postUrl, postUrls, count = 10 } = input;

    const apiKey = input.apiKey || process.env.API_KEY || '892bfe248b127a69be4455bd78168082022cfd75c70f6e4d7a7928d7ba10175f';
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };

    // Determine mode: single post, batch posts, or profile scrape
    const singlePostUrls = [];
    if (postUrl) singlePostUrls.push(postUrl);
    if (Array.isArray(postUrls)) singlePostUrls.push(...postUrls);

    // If we have post URLs, fetch each one
    if (singlePostUrls.length > 0) {
        console.log(`Fetching ${singlePostUrls.length} individual post(s)...`);
        for (const url of singlePostUrls) {
            try {
                const resp = await axios.post(`${API_URL}/api/v1/post`, { url }, { headers });
                if (resp.data?.success && resp.data?.data) {
                    await Actor.pushData({ ...resp.data.data, sourceUrl: url });
                    console.log(`✅ Fetched: ${url}`);
                } else {
                    console.log(`⚠️ No data for: ${url}`);
                    await Actor.pushData({ sourceUrl: url, error: resp.data?.error || 'No data returned' });
                }
            } catch (err) {
                console.error(`❌ Failed: ${url} — ${err.message}`);
                await Actor.pushData({ sourceUrl: url, error: err.message });
            }
        }
        return;
    }

    // Profile mode: extract username from profileUrl or use directly
    let username = profileUrl || input.username;
    if (!username) {
        throw new Error(
            'No input provided. Use one of:\n' +
            '  - "profileUrl": LinkedIn profile URL or username\n' +
            '  - "postUrl": single LinkedIn post URL\n' +
            '  - "postUrls": array of LinkedIn post URLs'
        );
    }

    // Extract username from URL if needed
    const match = username.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (match) username = match[1];

    console.log(`Fetching ${count} posts for profile: ${username}`);

    try {
        const resp = await axios.post(
            `${API_URL}/api/v1/posts`,
            { username, count },
            { headers }
        );

        if (resp.data?.success && resp.data?.data?.posts) {
            const posts = resp.data.data.posts;
            console.log(`✅ Got ${posts.length} posts`);
            for (const post of posts) {
                await Actor.pushData(post);
            }
        } else {
            console.log('⚠️ No posts returned');
            await Actor.pushData({ error: resp.data?.error || 'No posts returned', username });
        }
    } catch (err) {
        console.error(`❌ Failed to fetch posts: ${err.message}`);
        throw err;
    }
});
