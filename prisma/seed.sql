-- Demo catalogue with fixed ids so the README examples work as-is. Safe to run repeatedly.
INSERT INTO "products" ("id", "sku", "name", "price_cents", "stock", "updated_at") VALUES
  ('8f1c2a4e-6b1d-4c39-9a51-0d7a3f6e2b11', 'KB-001', 'Mechanical keyboard', 8900, 100, now()),
  ('2b7e9c1a-3f4d-4e8b-8c2a-5d6f7a8b9c22', 'MS-002', 'Wireless mouse', 2900, 250, now()),
  ('c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e33', 'MN-003', '27-inch monitor', 32900, 5, now())
ON CONFLICT ("sku") DO NOTHING;
