# LinkedIn Post Scraper — Extract Posts, Engagement & Media from Any Profile

Scrape LinkedIn profile posts at scale — get full post text, author details, engagement stats (likes, comments, reposts), media attachments, hashtags, and more. **No cookies or login needed.**

## ✨ Key Features

- 🔓 **No cookies required** — no risk of account bans or restrictions
- 👤 **Profile posts** — scrape recent posts from any public LinkedIn profile
- 🔗 **Individual post URLs** — fetch data for specific posts (single or batch)
- 📊 **Full engagement stats** — likes, comments, reposts, reaction breakdowns (love, celebrate, insightful, etc.)
- 🖼️ **Media extraction** — images, videos, documents, articles with thumbnails
- #️⃣ **Hashtags & mentions** — parsed from post content
- 👨‍💼 **Author info** — name, headline, profile URL, profile picture
- 📄 **Reshare support** — includes original post data for reshared/quoted posts
- ⚡ **Fast & reliable** — optimized backend with built-in rate limiting

## 📥 Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `profileUrl` | `string` | No* | LinkedIn profile URL or username (e.g., `https://www.linkedin.com/in/satyanadella` or just `satyanadella`) |
| `postUrl` | `string` | No* | Single LinkedIn post URL to scrape |
| `postUrls` | `string[]` | No* | Array of LinkedIn post URLs for batch scraping |
| `count` | `integer` | No | Number of posts to fetch from a profile (default: `10`, max: `100`) |

> **\*** At least one of `profileUrl`, `postUrl`, or `postUrls` must be provided.

### Usage Modes

1. **Profile scraping** — Provide `profileUrl` + optional `count` to get a profile's recent posts
2. **Single post** — Provide `postUrl` to scrape one specific post
3. **Batch posts** — Provide `postUrls` array to scrape multiple specific posts in one run

## 📊 Output Data Schema

Each post in the output dataset contains:

```json
{
  "urn": "7123456789012345678",
  "posted_at": {
    "date": "2025-05-15 14:30:20",
    "relative": "2 days ago",
    "timestamp": 1745678901234
  },
  "text": "Excited to announce our latest product launch! 🚀 #innovation #tech",
  "url": "https://www.linkedin.com/posts/johndoe_innovation-tech-activity-7123456789012345678-AbCd",
  "post_type": "regular",
  "author": {
    "first_name": "John",
    "last_name": "Doe",
    "headline": "CEO at Example Company",
    "username": "johndoe",
    "profile_url": "https://www.linkedin.com/in/johndoe",
    "profile_picture": "https://media.licdn.com/dms/image/profile-pic.jpg"
  },
  "stats": {
    "total_reactions": 523,
    "like": 400,
    "support": 25,
    "love": 60,
    "insight": 18,
    "celebrate": 20,
    "comments": 47,
    "reposts": 12
  },
  "media": {
    "type": "image",
    "url": "https://media.licdn.com/dms/image/sample-image.jpg",
    "thumbnail": "https://media.licdn.com/dms/image/sample-thumbnail.jpg"
  },
  "hashtags": ["innovation", "tech"],
  "reshared_post": null
}
```

### Media Types

Posts can include different media types: `image`, `images` (carousel), `video`, `document`, or `article` — each with relevant URLs and thumbnails.

## 🎯 Use Cases

- **Market Research** — Analyze what industry leaders and competitors are posting about. Track trending topics and content strategies.
- **Lead Generation** — Identify engaged prospects by analyzing who's posting about topics relevant to your business.
- **Content Analysis** — Study high-performing content patterns — what formats, lengths, and topics drive the most engagement.
- **Competitor Monitoring** — Track competitor announcements, product launches, and hiring activity through their LinkedIn posts.
- **Social Selling** — Build hyper-personalized outreach by referencing a prospect's recent LinkedIn activity.
- **Brand Monitoring** — Track mentions and posts about your brand across LinkedIn profiles.
- **Influencer Research** — Evaluate potential partners by analyzing their posting frequency, engagement rates, and audience.

## 💰 Pricing

This actor uses a **pay-per-event** pricing model:

- **~$2 per 1,000 posts** scraped
- No monthly subscription — pay only for what you use
- Free tier available on Apify for testing

## ❓ FAQ

**Do I need to provide my LinkedIn cookies or credentials?**
No. This actor uses a backend service that handles authentication. Your LinkedIn account is never at risk.

**Can I scrape any LinkedIn profile's posts?**
You can scrape posts from public LinkedIn profiles. Private or restricted profiles may return limited data.

**What's the maximum number of posts I can scrape per profile?**
Up to 100 posts per run. For larger volumes, run the actor multiple times.

**Can I scrape company page posts?**
Currently optimized for personal profile posts. Company page support may be added in future updates.

**How fresh is the data?**
Data is scraped in real-time — you always get the latest posts and engagement metrics.

**Does it work with LinkedIn post URLs from shares/reposts?**
Yes. The actor returns the full reshared post data including the original post content and author.

**What format is the output in?**
Data is returned as JSON in the Apify dataset. You can export to CSV, Excel, JSON, or connect via API.

## ⚠️ Rate Limits & Usage Notes

- Built-in rate limiting ensures reliable scraping without IP blocks
- Maximum of **100 posts** per profile per run
- For high-volume usage, space out runs or use Apify's scheduling feature
- The actor respects LinkedIn's infrastructure — excessive parallel runs may result in temporary throttling
- Results are stored in the Apify dataset and available via API for 7 days (default retention)

## 🔗 Related Resources

- [Apify Platform Documentation](https://docs.apify.com)
- [API Integration Guide](https://docs.apify.com/api/v2)
- [Apify Python Client](https://docs.apify.com/api/client/python)
- [Apify JavaScript Client](https://docs.apify.com/api/client/js)
