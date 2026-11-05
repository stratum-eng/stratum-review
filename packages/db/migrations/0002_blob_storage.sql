-- AI responses and oversized webhook payloads live in R2. The column holds the SHA-256 of the response:
-- files reviewed in one model call share a response, so they share one object.
ALTER TABLE file_reviews RENAME COLUMN raw_ai_output TO raw_ai_output_key;
ALTER TABLE webhook_deliveries ADD COLUMN payload_key TEXT;
