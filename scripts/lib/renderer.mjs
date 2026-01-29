import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

export async function ensureExists(p) {
    try { await stat(p); } catch (e) { return false; }
    return true;
}

export function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.html': return 'text/html; charset=utf-8';
        case '.js': return 'text/javascript; charset=utf-8';
        case '.mjs': return 'text/javascript; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        case '.png': return 'image/png';
        case '.svg': return 'image/svg+xml';
        default: return 'application/octet-stream';
    }
}

export async function startStaticServer(rootDir) {
    const safeRoot = path.resolve(rootDir);
    const server = http.createServer(async (req, res) => {
        try {
            const parsed = url.parse(req.url);
            let filePath = decodeURIComponent(parsed.pathname || '/');
            if (filePath === '/') {
                filePath = '/README.md';
            }
            // Resolve the requested path safely within the root directory
            const abs = path.resolve(safeRoot, '.' + filePath);
            if (!abs.startsWith(safeRoot + path.sep) && abs !== safeRoot) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Forbidden');
                return;
            }
            const data = await readFile(abs);
            res.writeHead(200, { 'Content-Type': contentTypeFor(abs) });
            res.end(data);
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseURL = `http://${addr.address}:${addr.port}`;
    return { server, baseURL };
}

export async function createBrowser() {
    const { chromium } = await import('playwright');
    return chromium.launch({ headless: true });
}

export async function renderPage({
    browser,
    baseURL,
    htmlPath,
    jsonPath,
    outPath,
    gpvKey,
    dayArg,
    theme,
    deviceScaleFactor,
    timeoutMs = 30000,
    projectRoot
}) {
    const context = await browser.newContext({
        deviceScaleFactor,
        locale: 'uk-UA',
        timezoneId: 'Europe/Kyiv',
    });
    const page = await context.newPage();

    try {
        const jsonBuf = await readFile(jsonPath, 'utf8');
        let scheduleData = null;
        try { scheduleData = JSON.parse(jsonBuf); } catch (e) {
            throw new Error(`Failed to parse JSON: ${e?.message || e}`);
        }

        await page.addInitScript(({ data, gpv }) => {
            window.__SCHEDULE__ = data;
            if (gpv) window.__GPV_KEY__ = gpv;
        }, { data: scheduleData, gpv: gpvKey });

        const relHtml = path.relative(projectRoot, htmlPath).split(path.sep).join('/');
        const urlToOpen = `${baseURL}/${relHtml}?theme=${theme}${dayArg ? `&day=${dayArg}` : ''}`;

        await page.goto(urlToOpen, { waitUntil: 'networkidle', timeout: Math.max(timeoutMs, 10000) });

        const hasMatrix = await page.$('#matrix');
        const hasToday = await page.$('#today');
        const hasSummary = await page.$('.summary-card');

        if (hasMatrix) {
            const matrixReady = page.waitForSelector(
              '#matrix tbody tr:last-child td:last-child',
              { timeout: timeoutMs }
            );

            const matrixEmpty = page.waitForSelector(
              '#matrix tbody tr th[colspan]',
              { timeout: timeoutMs }
            );

            await Promise.race([matrixReady, matrixEmpty]);
        }
        if (hasToday) {
            const todayReady = page.waitForSelector(
              '#today tbody tr td:last-child',
              { timeout: timeoutMs }
            );

            const todayEmpty = page.waitForSelector(
              '#today tbody tr th[colspan]',
              { timeout: timeoutMs }
            );

          await Promise.race([todayReady, todayEmpty]);
        }
        if (hasSummary) {
            const waitIntervals = page.waitForSelector('.summary-intervals > div', { timeout: timeoutMs }).catch(() => null);
            const waitOnBadge = page.waitForSelector('.status-badge.badge-on', { timeout: timeoutMs }).catch(() => null);
            const winner = await Promise.race([waitIntervals, waitOnBadge]);
            if (!winner) {
                throw new Error('Summary template did not render intervals or ON badge in time');
            }
        }
        if (!hasMatrix && !hasToday && !hasSummary) {
            throw new Error('Template did not render #matrix nor #today nor summary-card');
        }

        const container = page.locator('.container');
        const bbox = await container.boundingBox();
        if (!bbox) throw new Error('Failed to measure .container bounding box');

        await container.screenshot({ path: outPath, type: 'png' });

        return { width: Math.round(bbox.width), height: Math.round(bbox.height) };
    } finally {
        await page.close();
        await context.close();
    }
}
