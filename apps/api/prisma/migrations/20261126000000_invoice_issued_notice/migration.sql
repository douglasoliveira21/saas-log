-- Novo aviso ao cliente: "Nota fiscal emitida" (e-mail com XML e DANFE em anexo).
ALTER TABLE notification_rules DROP CONSTRAINT notification_rules_valid;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_valid CHECK (type IN ('INVOICE_DUE', 'ORDER_STATUS', 'INVOICE_ISSUED', 'COLLECTION') AND days_before BETWEEN 0 AND 30 AND min_overdue_days BETWEEN 1 AND 90 AND repeat_every_days BETWEEN 1 AND 90);
