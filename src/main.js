// FindLaw Directory Scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            practiceArea = '',
            state = '',
            county = '',
            city = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 20,
            startUrl,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://lawyers.findlaw.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const buildStartUrl = (practice, st, co, ci) => {
            if (!practice || !st) {
                throw new Error('practiceArea and state are required when startUrl is not provided');
            }
            let path = `https://lawyers.findlaw.com/${practice}/${st}/`;
            if (co) path += `${co}/`;
            else if (ci) path += `${ci}/`;
            return path;
        };

        const initial = startUrl || buildStartUrl(practiceArea, state, county, city);
        log.info(`Starting URL: ${initial}`);

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const seenUrls = new Set();

        // Extract lawyer data from JSON-LD (primary method)
        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            const lawyers = [];

            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');

                    // Handle ItemList containing LegalService entities
                    if (parsed['@type'] === 'ItemList' && Array.isArray(parsed.itemListElement)) {
                        for (const item of parsed.itemListElement) {
                            const entity = item.item || item;
                            if (!entity) continue;

                            const type = entity['@type'];
                            if (type === 'LegalService' || type === 'Attorney' || type === 'Organization') {
                                const address = entity.address || {};
                                const geo = entity.geo || {};

                                const lawyer = {
                                    name: entity.name || null,
                                    address: {
                                        street: address.streetAddress || null,
                                        city: address.addressLocality || null,
                                        state: address.addressRegion || null,
                                        zip: address.postalCode || null,
                                    },
                                    phone: entity.telephone || null,
                                    website: entity.sameAs || entity.url || null,
                                    rating: entity.aggregateRating?.ratingValue || null,
                                    reviews: entity.aggregateRating?.reviewCount || null,
                                    profileUrl: entity.mainEntityOfPage || entity.url || null,
                                    latitude: geo.latitude || null,
                                    longitude: geo.longitude || null,
                                    image: entity.image || null,
                                    practiceAreas: entity.areaServed || entity.knowsAbout || null,
                                };

                                // Format address as single string for display
                                const addressParts = [
                                    lawyer.address.street,
                                    lawyer.address.city,
                                    lawyer.address.state,
                                    lawyer.address.zip
                                ].filter(Boolean);
                                lawyer.addressFormatted = addressParts.join(', ');

                                lawyers.push(lawyer);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore JSON parsing errors
                }
            }

            return lawyers;
        }

        // Extract lawyer data from HTML (fallback method)
        function extractFromHtml($, baseUrl) {
            const lawyers = [];
            const cards = $('.fl-serp-card');

            cards.each((_, card) => {
                const $card = $(card);

                const name = $card.find('.fl-serp-card-title, a.directory_profile').first().text().trim() || null;
                const profileUrl = toAbs($card.find('a.directory_profile, .fl-serp-card-title').first().attr('href'), baseUrl);
                const website = toAbs($card.find('a.directory_website').first().attr('href'), baseUrl);
                const phone = $card.find('a.phone-button').first().text().trim() ||
                    $card.find('a.phone-button').first().attr('data-phone') || null;

                // Extract rating and reviews from text like "5.0 (2)"
                const reviewText = $card.find('.fl-serp-card-reviews-link').first().text().trim();
                let rating = null;
                let reviews = null;
                if (reviewText) {
                    const match = reviewText.match(/([\d.]+)\s*\((\d+)\)/);
                    if (match) {
                        rating = match[1];
                        reviews = parseInt(match[2], 10);
                    }
                }

                // Extract address (usually in plain text within card)
                const addressText = $card.text().replace(/\s+/g, ' ').trim();
                const addressMatch = addressText.match(/([^,]+,\s*[A-Z]{2}\s+\d{5})/);
                const address = addressMatch ? addressMatch[1] : null;

                const lawyer = {
                    name,
                    address: address || null,
                    addressFormatted: address || null,
                    phone,
                    website,
                    rating,
                    reviews,
                    profileUrl,
                    latitude: null,
                    longitude: null,
                    image: null,
                    practiceAreas: null,
                };

                if (name || profileUrl) {
                    lawyers.push(lawyer);
                }
            });

            return lawyers;
        }

        // Find next page URL
        function findNextPage($, currentUrl) {
            // Check for rel="next" link
            const nextLink = $('a.fl-pagination-button[rel="next"]').attr('href');
            if (nextLink) return toAbs(nextLink, currentUrl);

            // Fallback: look for "Next" button
            const nextButton = $('a').filter((_, el) => {
                const text = $(el).text().trim().toLowerCase();
                return text === 'next' || text === '›' || text === '»';
            }).first().attr('href');

            if (nextButton) return toAbs(nextButton, currentUrl);

            // Manual pagination: increment page number
            const url = new URL(currentUrl);
            const currentPage = parseInt(url.searchParams.get('page') || '1', 10);
            url.searchParams.set('page', String(currentPage + 1));
            return url.href;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 90,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const pageNo = request.userData?.pageNo || 1;
                crawlerLog.info(`Processing page ${pageNo}: ${request.url}`);

                // Try JSON-LD extraction first
                let lawyers = extractFromJsonLd($);

                // Fallback to HTML parsing if JSON-LD fails
                if (!lawyers || lawyers.length === 0) {
                    crawlerLog.info('JSON-LD extraction failed, falling back to HTML parsing');
                    lawyers = extractFromHtml($, request.url);
                }

                crawlerLog.info(`Found ${lawyers.length} lawyers on page ${pageNo}`);

                // Filter out duplicates and save
                const remaining = RESULTS_WANTED - saved;
                const toSave = [];

                for (const lawyer of lawyers) {
                    if (saved >= RESULTS_WANTED) break;

                    const uniqueKey = lawyer.profileUrl || lawyer.name;
                    if (uniqueKey && !seenUrls.has(uniqueKey)) {
                        seenUrls.add(uniqueKey);
                        toSave.push(lawyer);
                        saved++;
                    }
                }

                if (toSave.length > 0) {
                    await Dataset.pushData(toSave);
                    crawlerLog.info(`Saved ${toSave.length} lawyers (Total: ${saved}/${RESULTS_WANTED})`);
                }

                // Check if we need to paginate
                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    const nextUrl = findNextPage($, request.url);
                    if (nextUrl && nextUrl !== request.url) {
                        crawlerLog.info(`Enqueueing next page: ${nextUrl}`);
                        await enqueueLinks({
                            urls: [nextUrl],
                            userData: { pageNo: pageNo + 1 }
                        });
                    } else {
                        crawlerLog.info('No more pages found');
                    }
                } else {
                    crawlerLog.info(`Stopping: saved=${saved}, RESULTS_WANTED=${RESULTS_WANTED}, pageNo=${pageNo}, MAX_PAGES=${MAX_PAGES}`);
                }
            }
        });

        await crawler.run([{ url: initial, userData: { pageNo: 1 } }]);
        log.info(`✓ Scraping completed. Saved ${saved} lawyer listings.`);
    } catch (error) {
        log.error(`Fatal error: ${error.message}`);
        throw error;
    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
