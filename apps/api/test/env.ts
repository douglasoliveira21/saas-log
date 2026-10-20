process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.DATABASE_URL ??= 'postgresql://dh_app:dh_app_dev@localhost:5439/distribuihub_test';
process.env.DIRECT_URL ??= 'postgresql://postgres@localhost:5439/distribuihub_test';
process.env.DH_APP_PASSWORD ??= 'dh_app_dev';
process.env.CREDENTIALS_KEY ??= 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktMTIzNDU='; // 32 bytes, somente testes
process.env.WORKER_ENABLED = 'false';
process.env.ENABLE_SANDBOX_CONNECTOR = 'true';
