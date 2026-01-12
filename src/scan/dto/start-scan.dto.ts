import { IsUrl } from 'class-validator';

export class StartScanDto {
  @IsUrl({ require_tld: true }, { message: 'Yaroqli URL kiriting' })
  url: string;
}
