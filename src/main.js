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

                    // Handle CollectionPage with mainEntity.itemListElement
                    if (parsed['@type'] === 'CollectionPage' && parsed.mainEntity?.itemListElement) {
                        for (const item of parsed.mainEntity.itemListElement) {
                            const entity = item.item || item;
                            if (!entity) continue;

                            const address = entity.address || {};
                            const geo = entity.geo || {};
                            const aggregateRating = entity.aggregateRating || {};

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
                                rating: aggregateRating.ratingValue || null,
                                reviews: aggregateRating.reviewCount || null,
                                profileUrl: entity.mainEntityOfPage || entity.url || null,
                                latitude: geo.latitude || null,
                                longitude: geo.longitude || null,
                                image: (entity.image?.url || entity.image) || null,
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
                    // Handle ItemList containing LegalService entities (alternative structure)
                    else if (parsed['@type'] === 'ItemList' && Array.isArray(parsed.itemListElement)) {
                        for (const item of parsed.itemListElement) {
                            const entity = item.item || item;
                            if (!entity) continue;

                            const type = entity['@type'];
                            if (type === 'LegalService' || type === 'Attorney' || type === 'Organization') {
                                const address = entity.address || {};
                                const geo = entity.geo || {};
                                const aggregateRating = entity.aggregateRating || {};

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
                                    rating: aggregateRating.ratingValue || null,
                                    reviews: aggregateRating.reviewCount || null,
                                    profileUrl: entity.mainEntityOfPage || entity.url || null,
                                    latitude: geo.latitude || null,
                                    longitude: geo.longitude || null,
                                    image: (entity.image?.url || entity.image) || null,
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

                // Name
                const name = $card.find('.fl-serp-card-title, [data-testid="serp-card-title-link"]').first().text().trim() || null;

                // Profile URL
                const profileUrl = toAbs(
                    $card.find('a.directory_profile, .fl-serp-card-title, [data-testid="serp-card-title-link"]').first().attr('href'),
                    baseUrl
                );

                // Website
                const website = toAbs($card.find('a.directory_website').first().attr('href'), baseUrl);

                // Phone
                const phone = $card.find('a.phone-button').first().text().trim() ||
                    $card.find('a.phone-button').first().attr('data-phone') || null;

                // Rating and reviews from aria-label or text
                const reviewLink = $card.find('.fl-serp-card-reviews-link').first();
                let rating = null;
                let reviews = null;

                if (reviewLink.length) {
                    const ariaLabel = reviewLink.attr('aria-label') || '';
                    const ratingMatch = ariaLabel.match(/([\d.]+)\s*out of/i);
                    if (ratingMatch) rating = ratingMatch[1];

                    const reviewText = reviewLink.text().trim();
                    const reviewMatch = reviewText.match(/\((\d+)\)/);
                    if (reviewMatch) reviews = parseInt(reviewMatch[1], 10);
                }

                // Profile image
                const image = $card.find('.fl-serp-card-image-link img, .fl-serp-card-image img').first().attr('src') || null;

                // Practice areas (usually in the first span of card text)
                const practiceText = $card.find('.fl-serp-card-text span').first().text().trim();
                const practiceAreas = practiceText ? practiceText.replace(/\s*Lawyers?\s*$/i, '').trim() : null;

                // Address
                const addressText = $card.find('.fl-serp-card-location-link, .firm_name').text().trim() ||
                    $card.text().replace(/\s+/g, ' ').trim();
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
                    image,
                    practiceAreas,
                };

                if (name || profileUrl) {
                    lawyers.push(lawyer);
                }
            });

            return lawyers;
        }

        // Check if pagination should continue
        function shouldContinuePagination($, currentUrl, saved, pageNo) {
            // Check if we've reached our limits
            if (saved >= RESULTS_WANTED) {
                return { shouldContinue: false, reason: 'Reached results_wanted limit' };
            }
            if (pageNo >= MAX_PAGES) {
                return { shouldContinue: false, reason: 'Reached max_pages limit' };
            }

            // Check for Next button existence
            const nextButton = $('a[data-testid="fl-pagination-button-next"], .fl-pagination-button[aria-label="Next Page"]');
            if (nextButton.length === 0) {
                return { shouldContinue: false, reason: 'No Next button found (end of results)' };
            }

            // Check results count (e.g., "Results 1 to 20 of 20")
            const resultsText = $('.fl-pagination-results, [data-testid="fl-pagination-results"]').text().trim();
            const resultsMatch = resultsText.match(/Results\s+\d+\s+to\s+(\d+)\s+of\s+(\d+)/i);
            if (resultsMatch) {
                const currentEnd = parseInt(resultsMatch[1], 10);
                const total = parseInt(resultsMatch[2], 10);
                if (currentEnd >= total) {
                    return { shouldContinue: false, reason: `Reached end of results (${currentEnd} of ${total})` };
                }
            }

            return { shouldContinue: true, reason: null };
        }

        // Find next page URL
        function findNextPage($, currentUrl) {
            // Check for Next button with data-testid or aria-label
            const nextLink = $('a[data-testid="fl-pagination-button-next"], .fl-pagination-button[aria-label="Next Page"]').attr('href');
            if (nextLink) return toAbs(nextLink, currentUrl);

            // Fallback: look for rel="next"
            const relNext = $('a[rel="next"]').attr('href');
            if (relNext) return toAbs(relNext, currentUrl);

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

                // If no lawyers found on this page, stop pagination
                if (lawyers.length === 0) {
                    crawlerLog.info('No lawyers found on this page, stopping pagination');
                    return;
                }

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

                // Check if we should continue pagination
                const paginationCheck = shouldContinuePagination($, request.url, saved, pageNo);

                if (!paginationCheck.shouldContinue) {
                    crawlerLog.info(`Stopping pagination: ${paginationCheck.reason}`);
                    return;
                }

                // Enqueue next page
                const nextUrl = findNextPage($, request.url);
                if (nextUrl && nextUrl !== request.url) {
                    crawlerLog.info(`Enqueueing next page: ${nextUrl}`);
                    await enqueueLinks({
                        urls: [nextUrl],
                        userData: { pageNo: pageNo + 1 }
                    });
                } else {
                    crawlerLog.info('No valid next page URL found');
                }
            },
            async failedRequestHandler({ request, error }, context) {
                context.log.error(`Request ${request.url} failed: ${error.message}`);
                // Don't retry on 403 errors (blocking)
                if (error.message.includes('403')) {
                    context.log.warning('Received 403 error, stopping retries for this request');
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
