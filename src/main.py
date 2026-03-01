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


def parse_post_data(raw_response: dict, original_url: str = '') -> dict:
    """Parse raw Voyager API response into clean post data.
    Handles both nested format and normalized (data + included) format.
    """
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
        'repostCount': 0,
        'images': [],
        'videoUrl': None,
        'articleTitle': '',
        'articleLink': '',
        'hashtags': [],
        'type': 'text',
        'activityUrn': '',
        'fetchedAt': datetime.utcnow().isoformat() + 'Z',
    }

    # Check if normalized format (data + included)
    if 'data' in raw_response and 'included' in raw_response:
        data = raw_response['data']
        included = raw_response['included']
        
        # Build entity map
        entity_map = {}
        for item in included:
            urn = item.get('entityUrn', '')
            if urn:
                entity_map[urn] = item
        
        # Get activity URN
        result['activityUrn'] = data.get('urn', '')
        result['url'] = original_url or data.get('permalink', '')
        
        # Find UpdateV2 entity
        update_v2 = None
        for item in included:
            if item.get('$type') == 'com.linkedin.voyager.feed.render.UpdateV2':
                update_v2 = item
                break
        
        if update_v2:
            # Post text from commentary
            commentary = update_v2.get('commentary', {})
            if commentary:
                text_obj = commentary.get('text', {})
                result['postText'] = text_obj.get('text', '') if isinstance(text_obj, dict) else str(text_obj)
            
            # Actor info
            actor = update_v2.get('actor', {})
            if actor:
                name = actor.get('name', {})
                result['authorName'] = name.get('text', '') if isinstance(name, dict) else str(name)
                desc = actor.get('description', {})
                result['authorHeadline'] = desc.get('text', '') if isinstance(desc, dict) else str(desc)
                nav_url = actor.get('navigationUrl', '')
                if nav_url:
                    result['authorProfileUrl'] = nav_url.split('?')[0]
        
        # Find SocialActivityCounts for this post
        for item in included:
            if item.get('$type') == 'com.linkedin.voyager.feed.shared.SocialActivityCounts':
                # Check if it belongs to our post
                sd_urn = item.get('socialDetailEntityUrn', '')
                if 'activity:' + result['activityUrn'].split(':')[-1] in sd_urn or not result['likeCount']:
                    result['likeCount'] = item.get('numLikes', 0)
                    result['commentCount'] = item.get('numComments', 0)
                    result['shareCount'] = item.get('numShares', 0)
                    result['repostCount'] = item.get('numShares', 0)
                    # Only use the first match (usually the main post)
                    if 'activity:' + result['activityUrn'].split(':')[-1] in sd_urn:
                        break
        
        # Find images
        for item in included:
            if item.get('$type', '').endswith('MiniArticle'):
                result['articleTitle'] = item.get('title', '')
                result['type'] = 'article'
            
            # Check for video
            if item.get('$type') == 'com.linkedin.videocontent.VideoPlayMetadata':
                result['type'] = 'video'
                streams = item.get('progressiveStreams', [])
                if streams:
                    locs = streams[0].get('streamingLocations', [])
                    if locs:
                        result['videoUrl'] = locs[0].get('url', '')
    else:
        # Legacy nested format
        update_v2 = raw_response.get('value', {}).get('com.linkedin.voyager.feed.render.UpdateV2', raw_response)
        
        result['activityUrn'] = raw_response.get('urn', '') or raw_response.get('entityUrn', '')
        if not original_url and result['activityUrn']:
            result['url'] = f'https://www.linkedin.com/feed/update/{result["activityUrn"]}'
        
        actor = update_v2.get('actor', {})
        if actor:
            name = actor.get('name', {})
            result['authorName'] = name.get('text', '') if isinstance(name, dict) else str(name)
            desc = actor.get('description', {})
            result['authorHeadline'] = desc.get('text', '') if isinstance(desc, dict) else str(desc)
            nav_url = actor.get('navigationUrl', '')
            if nav_url:
                result['authorProfileUrl'] = nav_url.split('?')[0]
        
        commentary = update_v2.get('commentary', {})
        if commentary:
            text_obj = commentary.get('text', {})
            result['postText'] = text_obj.get('text', '') if isinstance(text_obj, dict) else str(text_obj)
        
        social_detail = update_v2.get('socialDetail', {})
        if social_detail:
            total_social = social_detail.get('totalSocialActivityCounts', {})
            result['likeCount'] = total_social.get('numLikes', 0)
            result['commentCount'] = total_social.get('numComments', 0)
            result['shareCount'] = total_social.get('numShares', 0)

    # Hashtags
    if result['postText']:
        result['hashtags'] = re.findall(r'#[\w\u00C0-\u024F]+', result['postText'])

    # Determine image type
    if not result['type'] or result['type'] == 'text':
        if result['images']:
            result['type'] = 'image'
        elif result['postText']:
            result['type'] = 'text'

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
            
            # Use proxy if provided in input, otherwise direct connection
            proxy_url = actor_input.get('proxyUrl', '')
            proxies = {}
            if proxy_url:
                proxies = {'http': proxy_url, 'https': proxy_url}
                logger.info(f'🌐 Using custom proxy')
            else:
                logger.info('🌐 Direct connection (no proxy)')
            
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
            jsessionid = actor_input.get('jsessionid', '')
            if not jsessionid:
                raise ValueError('jsessionid is required when using li_at cookie')
            
            # Strip quotes if present
            jsessionid_clean = jsessionid.strip('"')
            
            # Build raw session (bypass linkedin-api library for cookie auth)
            import requests as req
            raw_session = req.Session()
            raw_session.cookies.set('li_at', li_at, domain='.linkedin.com')
            raw_session.cookies.set('JSESSIONID', f'"{jsessionid_clean}"', domain='.linkedin.com')
            raw_session.headers.update({
                'csrf-token': jsessionid_clean,
                'x-restli-protocol-version': '2.0.0',
                'accept': 'application/vnd.linkedin.normalized+json+2.1',
                'x-li-lang': 'en_US',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            })
            
            # Create a simple wrapper to match the api.client.session interface
            class SimpleAPI:
                class client:
                    session = raw_session
            api = SimpleAPI()
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
