import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ScanService } from './scan.service';

@Injectable()
export class CronService {
    private readonly logger = new Logger(CronService.name);

    private sites = [
        'https://csec.uz',
        'https://xxx.uz',
        // 👉 keyin DBga ko‘chiramiz
    ];

    private running = false;

    constructor(private scan: ScanService) { }

    @Cron('0 */1 * * *')    /// 1 soat 
    async handleScan() {
        if (this.running) {
            this.logger.warn('⚠️ Previous scan still running');
            return;
        }

        this.running = true;
        this.logger.log('🔄 Auto scan started');

        try {
            await Promise.all(
                this.sites.map(site =>
                    this.scan.scan(site).catch(e => {
                        this.logger.error(`Error scanning ${site}: ${e.message}`);
                    })
                )
            );
        } finally {
            this.running = false;
            this.logger.log('✅ Auto scan finished');
        }
    }
}