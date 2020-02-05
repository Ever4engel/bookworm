import { promises as fs } from 'fs';
import path from 'path';
import Config, { IConfigBookConfiguration } from './Config';
import ClientWithThrottle from './Http/ClientWithThrottle';
import IContentAuth from './Http/IContentAuth';
import IContentCheckResponse from './Http/IContentCheckResponse';
import IHttpClient from './Http/IHttpClient';
import AuthorizeViewer from './Http/Requests/AuthorizeViewer';
import BookConfig from './Http/Requests/BookConfig';
import ContentCheck from './Http/Requests/ContentCheck';
import PutBookmark from './Http/Requests/PutBookmark';
import Page from './Page';

export default class Book {
    // tslint:disable-next-line:function-name
    public static async load(contentId: string, httpClient: IHttpClient): Promise<Book> {
        await new AuthorizeViewer(contentId).execute(httpClient);
        const contentConfig = await new ContentCheck(contentId).execute(httpClient);
        if (contentConfig.status !== '200') {
            throw new Error(`Unexpected config response status: ${contentConfig.status}`);
        }
        const encodedBookConfig = await new BookConfig(contentConfig.url, contentConfig.auth_info).execute(httpClient);

        return new Book(contentId, httpClient, contentConfig, encodedBookConfig);
    }

    public readonly pages: ReadonlyArray<Page>;
    private readonly throttledHttpClient: IHttpClient;
    private auth: IContentAuth;

    public constructor(
        private readonly contentId: string,
        private readonly httpClient: IHttpClient,
        private readonly contentConfig: IContentCheckResponse,
        encodedBookConfig: string,
    ) {
        this.throttledHttpClient = new ClientWithThrottle(httpClient, {
            frame: 60,
            limit: parseInt(process.env.BW_THROTTLE || '12', 10),
        });
        const config = new Config(encodedBookConfig, BookConfig.FILENAME).decode();
        const configuration: IConfigBookConfiguration = config[0].configuration as any;
        this.pages = configuration.contents.map(pageInfo => {
            const pageConfig = config[0][pageInfo.file];
            return new Page(
                pageInfo.index,
                pageInfo.file,
                pageConfig,
                this.throttledHttpClient,
                config[4],
                config[5],
                config[6],
                contentConfig.url,
            );
        });
        this.auth = contentConfig.auth_info;
    }

    public async download(folder: string) {
        const items = this.pages.map((page, index) => {
            const nextPage = this.pages[index + 1];

            return {
                page,
                nextPage,
            };
        });

        console.log('Downloading:');
        let ready = 0;
        const total = items.length;
        for (const item of items) {
            const filename = `page-${item.page.index.toString().padStart(3, '0')}.png`;

            try {
                const image = await item.page.image(this.auth);
                await fs.writeFile(path.join(folder, filename), image);
                console.log(`\t[${++ready}/${total}] ${filename}: Success`);

                if (item.nextPage) {
                    const pb = new PutBookmark(this.auth, this.contentId, item.page.pageId, item.nextPage.pageId);
                    const auth = await pb.execute(this.httpClient);
                    this.auth = {
                        ...this.auth,
                        ...auth,
                    };
                }
            } catch (err) {
                console.warn(`\t[${++ready}/${total}] ${filename}: Failed - ${err.stack}`);
            }
        }
    }
}
