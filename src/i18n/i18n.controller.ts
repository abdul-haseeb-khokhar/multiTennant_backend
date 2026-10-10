import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { I18nService } from './i18n.service';
import type { Translations } from './translation-files';
import { NAMESPACES } from './locales';

class LocaleEntry {
  @ApiProperty({ example: 'ur', description: 'BCP-47 code' })
  code: string;

  @ApiProperty({ example: 'اردو', description: "The language's own name" })
  name: string;

  @ApiProperty({ enum: ['ltr', 'rtl'] })
  dir: 'ltr' | 'rtl';
}

// Public and cacheable: the embedded widget loads these without a login. The ETag lets clients
// revalidate cheaply (304); translations only change with a deployment.
const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';

@ApiTags('i18n')
@Controller('i18n')
export class I18nController {
  constructor(private readonly i18nService: I18nService) {}

  @Get('locales')
  @Header('Cache-Control', CACHE_CONTROL)
  @ApiOperation({ summary: 'Available languages (public)' })
  @ApiOkResponse({ type: [LocaleEntry] })
  locales() {
    return this.i18nService.listLocales();
  }

  @Get(':locale/:namespace')
  @ApiOperation({
    summary: 'Translations of one namespace (public, cacheable)',
    description:
      'A flat map of stable dot-notation keys to ICU message strings. Keys missing in the requested language are filled in from `en`. Supports `If-None-Match` (304). For API errors use namespace `errors` with the error `code` as key.',
  })
  @ApiParam({
    name: 'locale',
    type: String,
    description: 'A locale code from GET /v1/i18n/locales.',
  })
  @ApiParam({ name: 'namespace', enum: [...NAMESPACES] })
  @ApiOkResponse({
    schema: { type: 'object', additionalProperties: { type: 'string' } },
  })
  @ApiNotFoundResponse({
    description: 'LOCALE_NOT_FOUND / NAMESPACE_NOT_FOUND',
  })
  namespace(
    @Param('locale') locale: string,
    @Param('namespace') namespace: string,
    @Res({ passthrough: true }) res: Response,
  ): Translations {
    const bundle = this.i18nService.get(locale, namespace);
    res.setHeader('ETag', bundle.etag);
    res.setHeader('Cache-Control', CACHE_CONTROL);
    return bundle.entries;
  }
}
