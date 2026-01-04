// FindLaw Directory Scraper - Optimized with Apify Stealth Best Practices
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// User-Agent rotation pool - realistic browser strings
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            startUrls = [],
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 20,
            collectDetails = false,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        // Parse startUrls - handle both array of objects and array of strings
        const urls = startUrls.map(item => typeof item === 'string' ? item : (item.url || item.requestsFromUrl)).filter(Boolean);

        if (!urls.length) {
            throw new Error('At least one start URL is required');
        }

        log.info(`Starting with ${urls.length} URL(s)`);

        const toAbs = (href, base = 'https://lawyers.findlaw.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const fixImageUrl = (url) => {
            if (!url) return null;
            if (typeof url === 'object') url = url.url || url['@id'] || null;
            if (!url || typeof url !== 'string') return null;
            if (url.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return url;
            return url + '.jpg';
        };

        const extractUrl = (urlValue) => {
            if (!urlValue) return null;
            if (typeof urlValue === 'string') return urlValue;
            if (typeof urlValue === 'object') return urlValue.url || urlValue['@id'] || urlValue.href || null;
            return null;
        };

        // Clean practice areas - comma separated
        const cleanPracticeAreas = (text) => {
            if (!text) return null;
            const areas = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0 && l.length < 100);
            return areas.length ? areas.join(', ') : null;
        };

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const seenUrls = new Set();
        const pendingLawyers = []; // Batch for detail pages

        // JSON-LD extraction
        function extractFromJsonLd($) {
            const lawyers = [];
            $('script[type="application/ld+json"]').each((_, script) => {
                try {
                    const parsed = JSON.parse($(script).html() || '');
                    const items = parsed['@type'] === 'CollectionPage' && parsed.mainEntity?.itemListElement
                        ? parsed.mainEntity.itemListElement
                        : (parsed['@type'] === 'ItemList' ? parsed.itemListElement : []);

                    for (const item of items || []) {
                        const entity = item.item || item;
                        if (!entity) continue;
                        const addr = entity.address || {};
                        const geo = entity.geo || {};
                        const rating = entity.aggregateRating || {};

                        lawyers.push({
                            name: entity.name || null,
                            address: { street: addr.streetAddress, city: addr.addressLocality, state: addr.addressRegion, zip: addr.postalCode },
                            addressFormatted: [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean).join(', '),
                            phone: entity.telephone || null,
                            website: extractUrl(entity.sameAs) || extractUrl(entity.url),
                            rating: rating.ratingValue || null,
                            reviews: rating.reviewCount || null,
                            profileUrl: extractUrl(entity.mainEntityOfPage) || extractUrl(entity.url),
                            latitude: geo.latitude || null,
                            longitude: geo.longitude || null,
                            image: fixImageUrl(entity.image?.url || entity.image),
                            practiceAreas: entity.areaServed || entity.knowsAbout || null,
                            bio: null,
                            people: null,
                        });
                    }
                } catch (e) { }
            });
            return lawyers;
        }

        // HTML fallback extraction
        function extractFromHtml($, baseUrl) {
            const lawyers = [];
            $('li.fl-serp-card').each((_, card) => {
                const $c = $(card);
                const name = $c.find('.fl-serp-card-title').first().text().trim() || null;
                const profileUrl = toAbs($c.find('.fl-serp-card-title, a.directory_profile').first().attr('href'), baseUrl);
                const phone = $c.find('a.phone-button').first().text().trim() || $c.find('a.phone-button').attr('data-phone') || null;
                const reviewLink = $c.find('.fl-serp-card-reviews-link').first();
                let rating = null, reviews = null;
                if (reviewLink.length) {
                    const ariaLabel = reviewLink.attr('aria-label') || '';
                    const rm = ariaLabel.match(/([\d.]+)\s*out of/i);
                    if (rm) rating = rm[1];
                    const rt = reviewLink.text().match(/\((\d+)\)/);
                    if (rt) reviews = parseInt(rt[1], 10);
                }
                const practiceSpan = $c.find('p.fl-serp-card-text > span:not(.firm_name)').first();
                let practiceAreas = practiceSpan.text().trim().replace(/\s*Lawyers?\s*$/i, '') || null;

                if (name || profileUrl) {
                    lawyers.push({
                        name, profileUrl, phone, rating, reviews, practiceAreas,
                        website: toAbs($c.find('a.directory_website').attr('href'), baseUrl),
                        image: fixImageUrl($c.find('.fl-serp-card-image-link img').attr('src')),
                        address: null, addressFormatted: null, latitude: null, longitude: null, bio: null, people: null,
                    });
                }
            });
            return lawyers;
        }

        // Detail page extraction
        function extractDetailPageData($) {
            const data = { bio: null, people: null, practiceAreas: null, rating: null, reviews: null };

            // Practice areas
            const paContainer = $('div.block_content_body').first();
            if (paContainer.length) data.practiceAreas = cleanPracticeAreas(paContainer.text());

            // Rating/reviews from JSON-LD
            $('script[type="application/ld+json"]').each((_, script) => {
                try {
                    const p = JSON.parse($(script).html() || '');
                    if (p.aggregateRating) {
                        data.rating = data.rating || p.aggregateRating.ratingValue;
                        data.reviews = data.reviews || p.aggregateRating.reviewCount;
                    }
                    if (p['@graph']) {
                        for (const item of p['@graph']) {
                            if (item.aggregateRating) {
                                data.rating = data.rating || item.aggregateRating.ratingValue;
                                data.reviews = data.reviews || item.aggregateRating.reviewCount;
                            }
                        }
                    }
                } catch (e) { }
            });

            // Bio
            const overview = $('.overview').first();
            if (overview.length) {
                const paras = [];
                overview.find('p').each((_, p) => {
                    const t = $(p).text().trim();
                    if (t && t !== 'Overview') paras.push(t);
                });
                if (paras.length) data.bio = paras.join('\n\n');
            }

            // People
            const people = [];
            $('.profile-profile-body').each((_, el) => {
                const n = $(el).text().trim();
                if (n) people.push(n);
            });
            if (people.length) data.people = people.join(', ');

            return data;
        }

        function shouldContinue($, saved, pageNo) {
            if (saved >= RESULTS_WANTED || pageNo >= MAX_PAGES) return false;
            const next = $('a[data-testid="fl-pagination-button-next"], .fl-pagination-button[aria-label="Next Page"]');
            return next.length > 0;
        }

        function findNextPage($, currentUrl) {
            const next = $('a[data-testid="fl-pagination-button-next"]').attr('href') || $('a[rel="next"]').attr('href');
            if (next) return toAbs(next, currentUrl);
            const url = new URL(currentUrl);
            url.searchParams.set('page', String(parseInt(url.searchParams.get('page') || '1', 10) + 1));
            return url.href;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 4,
            useSessionPool: true,
            persistCookiesPerSession: true,
            sessionPoolOptions: {
                maxPoolSize: 50,
                sessionOptions: {
                    maxUsageCount: 10,
                },
            },
            maxConcurrency: 8,
            minConcurrency: 2,
            requestHandlerTimeoutSecs: 45,
            navigationTimeoutSecs: 30,
            ignoreSslErrors: true,
            additionalMimeTypes: ['application/json'],
            // Stealth headers
            preNavigationHooks: [
                async ({ request, session }) => {
                    const ua = getRandomUserAgent();
                    request.headers = {
                        'User-Agent': ua,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'none',
                        'Sec-Fetch-User': '?1',
                        'Cache-Control': 'max-age=0',
                        'DNT': '1',
                    };
                    // Random delay for human-like behavior
                    await new Promise(r => setTimeout(r, randomDelay(200, 800)));
                }
            ],
            async requestHandler({ request, $, log: crawlerLog, session }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                // DETAIL page
                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    const lawyerData = request.userData?.lawyerData;
                    if (!lawyerData) return;

                    const detail = extractDetailPageData($);
                    const enriched = {
                        ...lawyerData,
                        bio: detail.bio || lawyerData.bio,
                        people: detail.people || lawyerData.people,
                        practiceAreas: detail.practiceAreas || lawyerData.practiceAreas,
                        rating: detail.rating || lawyerData.rating,
                        reviews: detail.reviews || lawyerData.reviews,
                    };

                    pendingLawyers.push(enriched);

                    // Batch push every 10 or when reaching limit
                    if (pendingLawyers.length >= 10 || saved + pendingLawyers.length >= RESULTS_WANTED) {
                        const batch = pendingLawyers.splice(0, RESULTS_WANTED - saved);
                        if (batch.length) {
                            await Dataset.pushData(batch);
                            saved += batch.length;
                            crawlerLog.info(`Saved batch of ${batch.length} lawyers (Total: ${saved}/${RESULTS_WANTED})`);
                        }
                    }
                    return;
                }

                // LIST page
                let lawyers = extractFromJsonLd($);
                if (!lawyers.length) lawyers = extractFromHtml($, request.url);

                if (!lawyers.length) {
                    crawlerLog.info(`Page ${pageNo}: No lawyers found`);
                    return;
                }

                const remaining = RESULTS_WANTED - saved - pendingLawyers.length;
                const toProcess = [];
                for (const lawyer of lawyers) {
                    if (toProcess.length >= remaining) break;
                    const key = lawyer.profileUrl || lawyer.name;
                    if (key && !seenUrls.has(key)) {
                        seenUrls.add(key);
                        toProcess.push(lawyer);
                    }
                }

                crawlerLog.info(`Page ${pageNo}: Found ${lawyers.length}, processing ${toProcess.length}`);

                if (collectDetails && toProcess.length) {
                    const reqs = toProcess.map(lawyer => {
                        const url = typeof lawyer.profileUrl === 'string' ? lawyer.profileUrl : extractUrl(lawyer.profileUrl);
                        if (url) {
                            lawyer.profileUrl = url;
                            return { url, userData: { label: 'DETAIL', lawyerData: lawyer } };
                        }
                        return null;
                    }).filter(Boolean);

                    if (reqs.length) await crawler.addRequests(reqs);
                } else if (toProcess.length) {
                    // Direct save without details - batch push
                    const clean = toProcess.map(({ bio, people, ...rest }) => rest);
                    await Dataset.pushData(clean);
                    saved += clean.length;
                    crawlerLog.info(`Saved ${clean.length} lawyers (Total: ${saved}/${RESULTS_WANTED})`);
                }

                // Pagination check
                const effectiveSaved = collectDetails ? seenUrls.size : saved;
                if (!shouldContinue($, effectiveSaved, pageNo)) return;
                if (collectDetails && seenUrls.size >= RESULTS_WANTED) return;

                const nextUrl = findNextPage($, request.url);
                if (nextUrl && nextUrl !== request.url) {
                    await crawler.addRequests([{ url: nextUrl, userData: { label: 'LIST', pageNo: pageNo + 1 } }]);
                }
            },
            failedRequestHandler({ request, log: crawlerLog }) {
                crawlerLog.warning(`Failed: ${request.url}`);
            }
        });

        // Create initial requests from all start URLs
        const initialRequests = urls.map(url => ({ url, userData: { label: 'LIST', pageNo: 1 } }));
        await crawler.run(initialRequests);

        // Push remaining pending lawyers
        if (pendingLawyers.length) {
            const remaining = Math.min(pendingLawyers.length, RESULTS_WANTED - saved);
            const batch = pendingLawyers.splice(0, remaining);
            if (batch.length) {
                await Dataset.pushData(batch);
                saved += batch.length;
            }
        }

        log.info(`✓ Done: ${saved} lawyers saved`);
    } catch (error) {
        log.error(`Error: ${error.message}`);
        throw error;
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
