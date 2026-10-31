import { Logger } from '@nestjs/common';

// Unit tests assert on behaviour, not log output.
Logger.overrideLogger(false);
