# FindLaw Lawyer Directory Scraper

Extract comprehensive lawyer and law firm data from FindLaw.com directory listings with lightning-fast JSON-LD extraction and intelligent HTML fallback.

## What Does This Actor Do?

This actor scrapes lawyer and law firm information from FindLaw.com directory pages. Simply provide a practice area, state, and optional county/city, or paste a direct FindLaw directory URL. The scraper automatically handles pagination and extracts detailed information including contact details, ratings, reviews, and geographic coordinates.

**Key Features:**
- ⚡ **Fast JSON-LD Extraction** - Prioritizes structured data for maximum speed and reliability
- 🔄 **Smart HTML Fallback** - Automatically switches to HTML parsing when needed
- 📊 **Rich Data Fields** - Name, address, phone, website, ratings, reviews, coordinates, and more
- 🎯 **Precise Targeting** - Filter by practice area, state, county, or city
- 🔁 **Automatic Pagination** - Seamlessly crawls multiple pages until your target is reached
- ✅ **Built-in Deduplication** - Ensures no duplicate listings in your results

## Use Cases

### Legal Research & Analysis
Build comprehensive databases of attorneys by practice area and location for market research, competitive analysis, or legal referral services.

### Lead Generation
Generate qualified leads for legal marketing agencies, CRM systems, or business development teams targeting specific legal niches.

### Market Intelligence
Analyze lawyer distribution, rating trends, and service coverage across different regions and practice areas.

### Directory Building
Create custom legal directories, comparison tools, or referral platforms with up-to-date lawyer information.

## Input Configuration

| Field | Type | Required | Description | Example |
|-------|------|----------|-------------|---------|
| `startUrl` | String | No* | Direct FindLaw directory URL to scrape | `https://lawyers.findlaw.com/bankruptcy-law/california/alameda-county/` |
| `practiceArea` | String | No* | Legal practice area slug | `bankruptcy-law`, `personal-injury-plaintiff`, `criminal-defense` |
| `state` | String | No* | U.S. state slug | `california`, `new-york`, `texas` |
| `county` | String | No | County slug for narrower searches | `alameda-county`, `los-angeles` |
| `city` | String | No | City slug for highly specific searches | `san-francisco`, `new-york` |
| `collectDetails` | Boolean | No | Visit detail pages to extract bio and team members (slower but richer data, default: false) | `true`, `false` |
| `results_wanted` | Integer | No | Maximum number of listings to extract (default: 100) | `50`, `200`, `1000` |
| `max_pages` | Integer | No | Safety limit on pages to visit (default: 20) | `5`, `10`, `50` |
| `proxyConfiguration` | Object | No | Proxy settings (residential recommended) | See Apify proxy docs |

**\*Note:** Either provide `startUrl` OR the combination of `practiceArea` + `state`. If `startUrl` is provided, it overrides other location fields.

### Input Example

```json
{
  "practiceArea": "bankruptcy-law",
  "state": "california",
  "county": "alameda-county",
  "results_wanted": 100,
  "max_pages": 10
}
```

Or with a direct URL:

```json
{
  "startUrl": "https://lawyers.findlaw.com/personal-injury-plaintiff/california/los-angeles/",
  "results_wanted": 50
}
```

## Output Format

Each lawyer/firm listing includes the following fields:

```json
{
  "name": "John Doe Law Firm",
  "address": {
    "street": "123 Main Street",
    "city": "Oakland",
    "state": "CA",
    "zip": "94612"
  },
  "addressFormatted": "123 Main Street, Oakland, CA 94612",
  "phone": "(510) 555-1234",
  "website": "https://www.johndoelaw.com",
  "rating": "5.0",
  "reviews": 42,
  "profileUrl": "https://lawyers.findlaw.com/profile/john-doe-law-firm",
  "latitude": "37.8044",
  "longitude": "-122.2712",
  "image": "https://lawyers.findlaw.com/static/c/images/env_prod/type_profile/firmwld_123/pid_1/firm_name.jpg",
  "practiceAreas": "Bankruptcy, Debt Relief",
  "bio": "John Doe Law Firm has been serving the Oakland community for over 20 years...",
  "people": "John Doe, Jane Smith, Robert Johnson"
}
```

### Field Descriptions

- **name** - Lawyer or law firm name
- **address** - Structured address object with street, city, state, and ZIP
- **addressFormatted** - Human-readable address string
- **phone** - Contact phone number
- **website** - Official website URL
- **rating** - Average rating (typically 0-5 scale)
- **reviews** - Total number of reviews
- **profileUrl** - FindLaw profile page URL
- **latitude/longitude** - Geographic coordinates (from JSON-LD when available)
- **image** - Profile image URL with proper extension (.jpg)
- **practiceAreas** - Practice areas as comma-separated string
- **bio** - Lawyer/firm biography and overview (only if `collectDetails` is enabled)
- **people** - Team members and attorneys (only if `collectDetails` is enabled)

## How It Works

### Step 1: URL Construction
The actor builds the appropriate FindLaw directory URL based on your input parameters or uses your provided `startUrl`.

### Step 2: Page Fetching
Using fast HTTP requests, the actor retrieves directory listing pages without the overhead of a browser.

### Step 3: Data Extraction
- **Primary Method:** Parses JSON-LD structured data embedded in the page for maximum speed and accuracy
- **Fallback Method:** If JSON-LD is unavailable, intelligently extracts data from HTML elements

### Step 4: Deduplication
Each listing is checked against previously seen entries to ensure no duplicates in your dataset.

### Step 5: Pagination
The actor automatically detects and follows "Next" page links until reaching your `results_wanted` limit or `max_pages` cap.

### Step 6: Data Storage
All extracted listings are saved to the Apify dataset in a clean, structured format ready for export.

## Performance & Limits

### Speed
- **Average:** 100-200 listings per minute
- **Factors:** Network speed, proxy quality, page complexity

### Resource Usage
- **Compute Units:** Approximately 0.01-0.02 CU per 100 listings
- **Memory:** Minimal (< 512 MB)

### Rate Limiting
The actor uses residential proxies by default to avoid rate limiting. For large-scale scraping (1000+ listings), consider:
- Increasing `max_pages` gradually
- Using high-quality residential proxies
- Running multiple smaller jobs instead of one large job

## Troubleshooting

### No Results Returned

**Possible Causes:**
- Invalid practice area, state, or county slug
- No lawyers listed for the specified criteria
- Incorrect `startUrl` format

**Solution:** Verify your input parameters match FindLaw's URL structure. Visit FindLaw.com manually to confirm listings exist for your criteria.

### Incomplete Data Fields

**Possible Causes:**
- Some lawyers don't provide all information
- FindLaw page structure varies by listing type

**Solution:** This is normal. Not all lawyers have ratings, reviews, or complete contact information. The actor extracts all available data.

### Scraper Stops Early

**Possible Causes:**
- Reached `max_pages` limit before `results_wanted`
- No more pages available for the search criteria

**Solution:** Increase `max_pages` or verify that enough listings exist for your search criteria.

### Proxy Errors

**Possible Causes:**
- Proxy configuration issues
- Residential proxy pool exhausted

**Solution:** Ensure `proxyConfiguration` is properly set. Use Apify's residential proxies for best results.

## Example Usage

### Via Apify Console
1. Open the actor in Apify Console
2. Fill in the input fields (practice area, state, etc.)
3. Click "Start"
4. Download results from the Dataset tab

### Via Apify API

```javascript
const { ApifyClient } = require('apify-client');

const client = new ApifyClient({
    token: 'YOUR_APIFY_TOKEN',
});

const input = {
    practiceArea: 'bankruptcy-law',
    state: 'california',
    county: 'alameda-county',
    results_wanted: 100,
};

const run = await client.actor('YOUR_USERNAME/findlaw-directory-scraper').call(input);
const { items } = await client.dataset(run.defaultDatasetId).listItems();

console.log(items);
```

### Via Python

```python
from apify_client import ApifyClient

client = ApifyClient('YOUR_APIFY_TOKEN')

run_input = {
    "practiceArea": "personal-injury-plaintiff",
    "state": "new-york",
    "results_wanted": 50,
}

run = client.actor('YOUR_USERNAME/findlaw-directory-scraper').call(run_input=run_input)

for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(item)
```

## Data Export Formats

Export your scraped data in multiple formats:
- **JSON** - Structured data with full field preservation
- **CSV** - Spreadsheet-compatible format
- **Excel** - Ready for analysis in Microsoft Excel
- **HTML** - Human-readable table format
- **XML** - For integration with legacy systems

## Legal & Ethical Considerations

This actor extracts publicly available information from FindLaw.com directory listings. Users are responsible for:
- Complying with FindLaw's Terms of Service
- Respecting data privacy regulations (GDPR, CCPA, etc.)
- Using scraped data ethically and legally
- Not overwhelming FindLaw's servers with excessive requests

Always review and comply with applicable laws and website terms before scraping.

## Support

Need help? Have questions?
- 📧 Contact the actor developer
- 📚 Check [Apify documentation](https://docs.apify.com)
- 💬 Join the [Apify Discord community](https://discord.com/invite/jyEM2PRvMU)

## Version History

**v1.0.0** - Initial release
- JSON-LD extraction with HTML fallback
- Automatic pagination support
- Built-in deduplication
- Comprehensive data fields
- Production-ready performance