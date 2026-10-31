import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Skips the API key check, e.g. for health probes. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
