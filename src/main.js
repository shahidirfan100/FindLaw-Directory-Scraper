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
            collectDetails = false,
            startUrl,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://lawyers.findlaw.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        // Fix image URLs by appending .jpg if no extension
        const fixImageUrl = (url) => {
            if (!url) return null;
            if (typeof url === 'object') url = url.url || url['@id'] || null;
            if (!url || typeof url !== 'string') return null;
            if (url.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return url;
            return url + '.jpg';
        };

        // Extract URL from potential object (JSON-LD often returns objects)
        const extractUrl = (urlValue) => {
            if (!urlValue) return null;
            if (typeof urlValue === 'string') return urlValue;
            if (typeof urlValue === 'object') {
                return urlValue.url || urlValue['@id'] || urlValue.href || null;
            }
            return null;
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
                                website: extractUrl(entity.sameAs) || extractUrl(entity.url) || null,
                                rating: aggregateRating.ratingValue || null,
                                reviews: aggregateRating.reviewCount || null,
                                profileUrl: extractUrl(entity.mainEntityOfPage) || extractUrl(entity.url) || null,
                                latitude: geo.latitude || null,
                                longitude: geo.longitude || null,
                                image: fixImageUrl(entity.image?.url || entity.image),
                                practiceAreas: entity.areaServed || entity.knowsAbout || null,
                                bio: null,
                                people: null,
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
                                    website: extractUrl(entity.sameAs) || extractUrl(entity.url) || null,
                                    rating: aggregateRating.ratingValue || null,
                                    reviews: aggregateRating.reviewCount || null,
                                    profileUrl: extractUrl(entity.mainEntityOfPage) || extractUrl(entity.url) || null,
                                    latitude: geo.latitude || null,
                                    longitude: geo.longitude || null,
                                    image: fixImageUrl(entity.image?.url || entity.image),
                                    practiceAreas: entity.areaServed || entity.knowsAbout || null,
                                    bio: null,
                                    people: null,
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
            // Use li.fl-serp-card to get the card containers
            const cards = $('li.fl-serp-card');

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

                // Profile image - fix URL by adding .jpg extension
                const imageSrc = $card.find('.fl-serp-card-image-link img, .fl-serp-card-image img').first().attr('src');
                const image = fixImageUrl(imageSrc);

                // Practice areas - use p.fl-serp-card-text > span:not(.firm_name)
                const practiceSpan = $card.find('p.fl-serp-card-text > span:not(.firm_name)').first();
                let practiceAreas = null;
                if (practiceSpan.length) {
                    let practiceText = practiceSpan.text().trim();
                    // Remove "Lawyers" or "Lawyer" suffix
                    practiceText = practiceText.replace(/\s*Lawyers?\s*$/i, '').trim();
                    if (practiceText) {
                        practiceAreas = practiceText;
                    }
                }

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
                    bio: null,
                    people: null,
                };

                if (name || profileUrl) {
                    lawyers.push(lawyer);
                }
            });

            return lawyers;
        }

        // Extract detail page data (bio and people)
        function extractDetailPageData($) {
            const data = {
                bio: null,
                people: null,
                practiceAreas: null,
                rating: null,
                reviews: null,
            };

            // Extract practice areas from detail page - use div.block_content_body
            const practiceAreasContainer = $('div.block_content_body, #profile-tabs__panel--profile-info div.block_content_body').first();
            if (practiceAreasContainer.length) {
                const practiceText = practiceAreasContainer.text().trim();
                if (practiceText) {
                    data.practiceAreas = practiceText;
                }
            }

            // Try JSON-LD for rating/reviews on detail page
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    if (parsed.aggregateRating) {
                        data.rating = parsed.aggregateRating.ratingValue || null;
                        data.reviews = parsed.aggregateRating.reviewCount || null;
                    }
                } catch (e) { /* ignore */ }
            }

            // Fallback: extract rating from HTML
            if (!data.rating) {
                const ratingEl = $('.avvo-rating-badge, .fl-rating-value, [data-testid="rating"]').first();
                if (ratingEl.length) {
                    const ratingText = ratingEl.text().trim();
                    const ratingMatch = ratingText.match(/([\d.]+)/);
                    if (ratingMatch) data.rating = ratingMatch[1];
                }
            }

            // Extract bio/about from Overview section - try multiple selectors
            const overviewContainer = $('.overview').first();
            if (overviewContainer.length) {
                // Get all paragraphs within overview
                const bioParagraphs = [];
                overviewContainer.find('p').each((_, p) => {
                    const text = $(p).text().trim();
                    if (text && text !== 'Overview') {
                        bioParagraphs.push(text);
                    }
                });
                if (bioParagraphs.length) {
                    data.bio = bioParagraphs.join('\n\n');
                }
            }

            // Fallback: try h3#overview approach
            if (!data.bio) {
                const overviewHeading = $('h3#overview, h2#overview').first();
                if (overviewHeading.length) {
                    const bioParagraphs = [];
                    let nextElement = overviewHeading.next();
                    while (nextElement.length && nextElement.is('p')) {
                        const text = nextElement.text().trim();
                        if (text) bioParagraphs.push(text);
                        nextElement = nextElement.next();
                    }
                    if (bioParagraphs.length) {
                        data.bio = bioParagraphs.join('\n\n');
                    }
                }
            }

            // Extract people/team members
            const peopleLinks = $('.profile-profile-body');
            if (peopleLinks.length) {
                const people = [];
                peopleLinks.each((_, link) => {
                    const name = $(link).text().trim();
                    if (name) people.push(name);
                });
                if (people.length) {
                    data.people = people.join(', ');
                }
            }

            return data;
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
            maxRequestRetries: 2,
            useSessionPool: true,
            persistCookiesPerSession: true,
            maxConcurrency: 3,
            minConcurrency: 1,
            requestHandlerTimeoutSecs: 90,
            // Add stealth delays
            navigationTimeoutSecs: 60,
            sameDomainDelaySecs: 2,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                // Handle detail page requests
                if (label === 'DETAIL') {
                    // Check if we've already reached the limit
                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(`Skipping detail page - already at limit (${saved}/${RESULTS_WANTED})`);
                        return;
                    }

                    const lawyerData = request.userData?.lawyerData;
                    if (!lawyerData) {
                        crawlerLog.warning('Detail page request missing lawyer data');
                        return;
                    }

                    try {
                        const detailData = extractDetailPageData($);

                        // Merge detail data with listing data (detail page data takes priority if available)
                        const enrichedLawyer = {
                            ...lawyerData,
                            bio: detailData.bio || lawyerData.bio,
                            people: detailData.people || lawyerData.people,
                            practiceAreas: detailData.practiceAreas || lawyerData.practiceAreas,
                            rating: detailData.rating || lawyerData.rating,
                            reviews: detailData.reviews || lawyerData.reviews,
                        };

                        await Dataset.pushData(enrichedLawyer);
                        saved++;
                        crawlerLog.info(`Saved lawyer with details: ${enrichedLawyer.name} (Total: ${saved}/${RESULTS_WANTED})`);
                    } catch (error) {
                        crawlerLog.error(`Failed to extract detail data: ${error.message}`);
                        // Save listing data as fallback
                        await Dataset.pushData(lawyerData);
                        saved++;
                    }
                    return;
                }

                // Handle listing page requests
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

                // Filter out duplicates and process - only take what we need
                const remaining = RESULTS_WANTED - saved;
                const toProcess = [];

                for (const lawyer of lawyers) {
                    if (toProcess.length >= remaining) break;

                    const uniqueKey = lawyer.profileUrl || lawyer.name;
                    if (uniqueKey && !seenUrls.has(uniqueKey)) {
                        seenUrls.add(uniqueKey);
                        toProcess.push(lawyer);
                    }
                }

                crawlerLog.info(`Processing ${toProcess.length} lawyers (need ${remaining} more)`);

                // If collectDetails is enabled, enqueue detail pages
                if (collectDetails && toProcess.length > 0) {
                    crawlerLog.info(`Enqueueing ${toProcess.length} detail pages`);
                    const detailRequests = [];
                    for (const lawyer of toProcess) {
                        // Ensure profileUrl is a valid string
                        const profileUrlStr = typeof lawyer.profileUrl === 'string' ? lawyer.profileUrl : extractUrl(lawyer.profileUrl);
                        if (profileUrlStr && typeof profileUrlStr === 'string') {
                            // Update lawyer with string profileUrl
                            lawyer.profileUrl = profileUrlStr;
                            detailRequests.push({
                                url: profileUrlStr,
                                userData: { label: 'DETAIL', lawyerData: lawyer }
                            });
                        } else {
                            // No valid profile URL, save directly without detail fields
                            const { bio, people, ...lawyerWithoutDetailFields } = lawyer;
                            await Dataset.pushData(lawyerWithoutDetailFields);
                            saved++;
                        }
                    }
                    if (detailRequests.length > 0) {
                        await crawler.addRequests(detailRequests);
                    }
                } else {
                    // Save directly without detail pages - remove bio/people fields
                    if (toProcess.length > 0) {
                        const lawyersWithoutDetailFields = toProcess.map(lawyer => {
                            const { bio, people, ...rest } = lawyer;
                            return rest;
                        });
                        await Dataset.pushData(lawyersWithoutDetailFields);
                        saved += lawyersWithoutDetailFields.length;
                        crawlerLog.info(`Saved ${lawyersWithoutDetailFields.length} lawyers (Total: ${saved}/${RESULTS_WANTED})`);
                    }
                }

                // For collectDetails mode, count enqueued detail pages toward the limit
                // For non-collectDetails mode, count saved lawyers
                const effectiveSaved = collectDetails ? seenUrls.size : saved;

                // Check if we should continue pagination
                const paginationCheck = shouldContinuePagination($, request.url, effectiveSaved, pageNo);

                if (!paginationCheck.shouldContinue) {
                    crawlerLog.info(`Stopping pagination: ${paginationCheck.reason}`);
                    return;
                }

                // Don't enqueue more pages if we already have enough detail pages queued
                if (collectDetails && seenUrls.size >= RESULTS_WANTED) {
                    crawlerLog.info(`Stopping pagination: Already enqueued ${seenUrls.size} detail pages`);
                    return;
                }

                // Enqueue next page
                const nextUrl = findNextPage($, request.url);
                if (nextUrl && nextUrl !== request.url) {
                    crawlerLog.info(`Enqueueing next page: ${nextUrl}`);
                    await crawler.addRequests([{
                        url: nextUrl,
                        userData: { label: 'LIST', pageNo: pageNo + 1 }
                    }]);
                } else {
                    crawlerLog.info('No valid next page URL found');
                }
            },
            async failedRequestHandler({ request }, { log: crawlerLog }) {
                crawlerLog.error(`Request ${request.url} failed after max retries`);
            }
        });

        await crawler.run([{ url: initial, userData: { label: 'LIST', pageNo: 1 } }]);
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

