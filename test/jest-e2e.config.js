/** @type {import('jest').Config} */
module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  testRegex: 'test/e2e/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@app/(common|database|messaging)(|/.*)$': '<rootDir>/libs/$1/src$2',
  },
  globalSetup: '<rootDir>/test/e2e/global-setup.ts',
  setupFiles: ['<rootDir>/test/e2e/setup-env.ts'],
  testTimeout: 30000,
};
