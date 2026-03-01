"""
LinkedIn Post Scraper - Apify Actor
Uses linkedin-api library (Android app auth endpoint) for reliable authentication.
No browser needed, no OTP challenges, no TLS fingerprinting issues.
"""

import json
import re
import logging
from datetime import datetime
from apify import Actor

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def extract_activity_id(url: str) -> str | None:
    """Extract activity ID from various LinkedIn post URL formats."""
    patterns = [
        r'activity[- ](\d+)',
        r'urn:li:activity:(\d+)',
        r'urn:li:ugcPost:(\d+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, url, re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def parse_post_data(raw_update: dict, original_url: str = '') -> dict:
    """Parse raw Voyager API response into clean post data."""
    result = {
        'success': False,
        'url': original_url,
        'authorName': '',
        'authorHeadline': '',
        'authorProfileUrl': '',
        'postText': '',
        'timestamp': '',
        'likeCount': 0,
        'commentCount': 0,
        'shareCount': 0,
        'images': [],
        'videoUrl': None,
        'articleTitle': '',
        'articleLink': '',
        'hashtags': [],
        'type': 'text',
        'activityUrn': '',
        'fetchedAt': datetime.utcnow().isoformat() + 'Z',
    }

    # Navigate the nested structure
    update_v2 = raw_update.get('value', {}).get('com.linkedin.voyager.feed.render.UpdateV2', {})
    if not update_v2:
        # Try flat structure (from feed/updates endpoint)
        update_v2 = raw_update

    # Activity URN
    urn = raw_update.get('urn', '') or raw_update.get('entityUrn', '')
    result['activityUrn'] = urn
    if not original_url and urn:
        result['url'] = f'https://www.linkedin.com/feed/update/{urn}'

    # Actor (author)
    actor = update_v2.get('actor', {})
    if actor:
        name = actor.get('name', {})
        result['authorName'] = name.get('text', '') if isinstance(name, dict) else str(name)
        
        desc = actor.get('description', {})
        result['authorHeadline'] = desc.get('text', '') if isinstance(desc, dict) else str(desc)
        
        nav_url = actor.get('navigationUrl', '')
        if nav_url:
            result['authorProfileUrl'] = nav_url.split('?')[0]

    # Commentary (post text)
    commentary = update_v2.get('commentary', {})
    if commentary:
        text_obj = commentary.get('text', {})
        result['postText'] = text_obj.get('text', '') if isinstance(text_obj, dict) else str(text_obj)

    # Social details
    social_detail = update_v2.get('socialDetail', {})
    if social_detail:
        total_social = social_detail.get('totalSocialActivityCounts', {})
        result['likeCount'] = total_social.get('numLikes', 0) or total_social.get('reactionTypeCounts', [{}])
        result['commentCount'] = total_social.get('numComments', 0)
        result['shareCount'] = total_social.get('numShares', 0)
        
        # Handle reactionTypeCounts for like count
        if isinstance(result['likeCount'], list):
            result['likeCount'] = sum(r.get('count', 0) for r in result['likeCount'])

    # Content (images, video, articles)
    content = update_v2.get('content', {})
    if content:
        # Image
        images_content = content.get('com.linkedin.voyager.feed.render.ImageComponent', {})
        if images_content:
            for img in images_content.get('images', []):
                attrs = img.get('attributes', [])
                for attr in attrs:
                    vector_img = attr.get('vectorImage', {})
                    artifacts = vector_img.get('artifacts', [])
                    if artifacts:
                        root_url = vector_img.get('rootUrl', '')
                        # Get largest image
                        largest = max(artifacts, key=lambda a: a.get('width', 0), default={})
                        file_id = largest.get('fileIdentifyingUrlPathSegment', '')
                        if root_url and file_id:
                            result['images'].append(f'{root_url}{file_id}')
            if result['images']:
                result['type'] = 'image'

        # Video
        video_content = content.get('com.linkedin.voyager.feed.render.LinkedInVideoComponent', {})
        if video_content:
            result['type'] = 'video'
            # Video URL may be in progressiveStreams
            video_play = video_content.get('videoPlayMetadata', {})
            streams = video_play.get('progressiveStreams', [])
            if streams:
                result['videoUrl'] = streams[0].get('streamingLocations', [{}])[0].get('url', '')

        # Article
        article_content = content.get('com.linkedin.voyager.feed.render.ArticleComponent', {})
        if article_content:
            result['type'] = 'article'
            title = article_content.get('title', {})
            result['articleTitle'] = title.get('text', '') if isinstance(title, dict) else str(title)
            result['articleLink'] = article_content.get('navigationUrl', '')

    # Hashtags
    if result['postText']:
        tags = re.findall(r'#[\w\u00C0-\u024F]+', result['postText'])
        result['hashtags'] = tags

    # Timestamp
    result['timestamp'] = str(raw_update.get('createdTime', ''))

    result['success'] = bool(result['postText'] or result['authorName'])
    return result


async def main():
    async with Actor:
        actor_input = await Actor.get_input() or {}
        
        email = actor_input.get('email', '')
        password = actor_input.get('password', '')
        li_at = actor_input.get('li_at', '')
        
        post_url = actor_input.get('postUrl', '')
        post_urls = actor_input.get('postUrls', [])
        
        # Collect URLs
        urls = []
        if post_url:
            urls.append(post_url)
        if isinstance(post_urls, list):
            urls.extend(post_urls)
        
        if not urls:
            raise ValueError('Provide postUrl or postUrls')
        
        logger.info(f'📝 Scraping {len(urls)} LinkedIn post(s)...')
        
        # Authenticate
        from linkedin_api import Linkedin
        
        if email and password:
            logger.info('🔐 Authenticating with email/password (Android API)...')
            
            # Use Apify residential proxy if available, otherwise direct
            import os
            apify_token = os.environ.get('APIFY_PROXY_PASSWORD', '')
            proxies = {}
            if apify_token:
                proxy_url = f'http://groups-RESIDENTIAL,country-US:{apify_token}@proxy.apify.com:8000'
                proxies = {'http': proxy_url, 'https': proxy_url}
                logger.info(f'🌐 Using Apify residential proxy')
            else:
                logger.info('🌐 No proxy configured, using direct connection')
                # Log available env vars for debugging
                proxy_vars = {k: v[:15]+'...' for k, v in os.environ.items() if 'PROXY' in k.upper() or 'TOKEN' in k.upper() or 'APIFY' in k.upper()}
                logger.info(f'  Env vars: {json.dumps(proxy_vars)}')
            
            try:
                api = Linkedin(email, password, proxies=proxies)
                logger.info('✅ Authenticated successfully!')
            except Exception as e:
                error_msg = str(e)
                logger.error(f'❌ Authentication failed: {error_msg}')
                for url in urls:
                    await Actor.push_data({
                        'url': url,
                        'success': False,
                        'error': f'Authentication failed: {error_msg}',
                        'fetchedAt': datetime.utcnow().isoformat() + 'Z',
                    })
                return
        elif li_at:
            logger.info('🔐 Using li_at cookie...')
            from requests.cookies import RequestsCookieJar
            cookies = RequestsCookieJar()
            cookies.set('li_at', li_at, domain='.linkedin.com', path='/')
            jsessionid = actor_input.get('jsessionid', f'"ajax:{int(datetime.utcnow().timestamp() * 1000)}"')
            cookies.set('JSESSIONID', jsessionid, domain='.linkedin.com', path='/')
            
            api = Linkedin('', '', authenticate=False, cookies=cookies)
            logger.info('✅ Cookie session created')
        else:
            raise ValueError('Provide email+password OR li_at cookie')
        
        # Scrape each post
        for i, url in enumerate(urls):
            activity_id = extract_activity_id(url)
            logger.info(f'📝 [{i+1}/{len(urls)}] Fetching activity: {activity_id}')
            
            if not activity_id:
                logger.error(f'  ❌ Could not extract activity ID from URL: {url}')
                await Actor.push_data({
                    'url': url,
                    'success': False,
                    'error': 'Could not extract activity ID from URL',
                    'fetchedAt': datetime.utcnow().isoformat() + 'Z',
                })
                continue
            
            try:
                # Fetch post via Voyager API
                urn = f'urn:li:activity:{activity_id}'
                res = api.client.session.get(
                    f'https://www.linkedin.com/voyager/api/feed/updates/{urn}',
                )
                
                if res.status_code == 200:
                    raw_data = res.json()
                    result = parse_post_data(raw_data, url)
                    
                    if result['success']:
                        logger.info(f'  ✅ {result["authorName"]}: {result["postText"][:80]}...')
                    else:
                        # Check if it's a "cannot be displayed" response
                        content = raw_data.get('value', {}).get('com.linkedin.voyager.feed.render.UpdateV2', {}).get('content', {})
                        entity = content.get('com.linkedin.voyager.feed.render.EntityComponent', {})
                        title = entity.get('title', {}).get('text', '')
                        if 'cannot be displayed' in title.lower():
                            result['error'] = 'Post cannot be displayed (may be deleted, restricted, or from a non-connected user)'
                            logger.warning(f'  ⚠️ {title}')
                        else:
                            result['error'] = 'Post loaded but content extraction failed'
                            logger.warning('  ⚠️ Content extraction returned empty')
                        result['rawResponse'] = raw_data
                    
                    await Actor.push_data(result)
                elif res.status_code == 404:
                    logger.error(f'  ❌ Post not found (404)')
                    
                    # Try ugcPost format
                    urn2 = f'urn:li:ugcPost:{activity_id}'
                    res2 = api.client.session.get(
                        f'https://www.linkedin.com/voyager/api/feed/updates/{urn2}',
                    )
                    if res2.status_code == 200:
                        raw_data = res2.json()
                        result = parse_post_data(raw_data, url)
                        await Actor.push_data(result)
                    else:
                        await Actor.push_data({
                            'url': url,
                            'success': False,
                            'error': f'Post not found (tried activity and ugcPost URNs)',
                            'fetchedAt': datetime.utcnow().isoformat() + 'Z',
                        })
                else:
                    logger.error(f'  ❌ API returned {res.status_code}: {res.text[:200]}')
                    await Actor.push_data({
                        'url': url,
                        'success': False,
                        'error': f'API error: {res.status_code} — {res.text[:200]}',
                        'fetchedAt': datetime.utcnow().isoformat() + 'Z',
                    })
                    
            except Exception as e:
                logger.error(f'  ❌ Error: {str(e)}')
                await Actor.push_data({
                    'url': url,
                    'success': False,
                    'error': str(e),
                    'fetchedAt': datetime.utcnow().isoformat() + 'Z',
                })
            
            # Rate limiting
            if i < len(urls) - 1:
                import time, random
                delay = 2 + random.random() * 3
                logger.info(f'  ⏳ Waiting {delay:.1f}s...')
                time.sleep(delay)
        
        logger.info('\n✅ Done!')


if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
