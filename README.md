# LinkedIn Post Scraper

A powerful and reliable Apify Actor for scraping LinkedIn posts and profiles. Extract post content, author information, engagement metrics, and more without requiring authentication.

## Features

- **No Login Required**: Scrapes public LinkedIn posts using public API endpoints
- **Batch Processing**: Process multiple URLs in a single run
- **Structured Data Extraction**: Extracts titles, descriptions, images, and Open Graph metadata
- **JSON-LD Support**: Parses structured data when available
- **Error Handling**: Graceful error handling with retry logic
- **Rate Limiting**: Built-in rate limiting to avoid IP blocks
- **Fast & Reliable**: Optimized for speed and reliability

## Use Cases

- **Market Research**: Analyze competitor LinkedIn activity
- **Content Monitoring**: Track brand mentions and posts
- **Lead Generation**: Extract author information from posts
- **Data Analysis**: Collect LinkedIn data for analysis
- **Competitive Intelligence**: Monitor industry trends

## How to Use

### Input Schema

The Actor accepts the following input:

```json
{
  "postUrl": "https://www.linkedin.com/posts/username_postid-",
  "postUrls": [
    "https://www.linkedin.com/posts/user1_postid1-",
    "https://www.linkedin.com/posts/user2_postid2-"
  ]
}
```

### Input Parameters

- **postUrl** (string, optional): Single LinkedIn post or profile URL
- **postUrls** (array, optional): Array of LinkedIn URLs for batch processing
- **includeComments** (boolean, optional): Attempt to scrape comments (experimental)
- **maxRetries** (integer, optional): Number of retry attempts (1-5, default: 3)

### Output

The Actor outputs structured data for each post:

```json
{
  "url": "https://www.linkedin.com/posts/satyanadella_...",
  "success": true,
  "data": {
    "title": "Post title",
    "description": "Post content",
    "image": "https://image-url.jpg",
    "url": "https://canonical-url",
    "type": "article",
    "structured": {}
  },
  "fetchedAt": "2024-01-19T22:00:00.000Z"
}
```

## Error Handling

- **404 Not Found**: Post URL is invalid or deleted
- **403 Forbidden**: Access denied, may need proxy
- **429 Rate Limited**: Too many requests, will retry with backoff
- **500+ Server Error**: Server issue, will retry automatically

## Tips & Best Practices

1. **URL Format**: Ensure LinkedIn URLs are in the correct format
2. **Rate Limiting**: Adjust `LINKEDIN_RATE_LIMIT` environment variable for speed/reliability tradeoff
3. **Batch Processing**: Use `postUrls` array for processing multiple posts efficiently
4. **Proxy Support**: Use Apify Proxy for large-scale scraping
5. **Error Monitoring**: Monitor failed runs in the Apify console

## Technical Details

- **Technology**: Node.js with Axios and Cheerio
- **Deployment**: Apify Actor with Docker containerization
- **Requirements**: No authentication needed
- **Performance**: Optimized for fast execution

## API Documentation

For complete documentation, visit the [Apify Actor documentation](https://docs.apify.com/platform/actors).

## Support

For issues or feature requests, please visit the [GitHub repository](https://github.com/buzz39/linkedin-post-scrapper-apify).

## License

MIT License - See LICENSE file for details
