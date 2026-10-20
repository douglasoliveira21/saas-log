module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\.(spec|e2e-spec)\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { diagnostics: { ignoreCodes: [151001] } }] },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/env.ts'],
  testTimeout: 30000,
};
